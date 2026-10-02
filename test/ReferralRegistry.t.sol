// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReferralRegistry} from "../contracts/ReferralRegistry.sol";

contract ReferralRegistryTest is Test {
    ReferralRegistry registry;

    address root = makeAddr("root");
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address erin = makeAddr("erin");

    event Bound(address indexed user, address indexed referrer);
    event ReferrerCorrected(address indexed user, address indexed from, address indexed to);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    function setUp() public {
        registry = new ReferralRegistry(root, owner);
    }

    function bind(address who, address upline) internal {
        vm.prank(who);
        registry.bind(upline);
    }

    function correct(address user, address newReferrer) internal {
        vm.prank(owner);
        registry.correctReferrer(user, newReferrer);
    }

    /// A chain root -> alice -> bob -> carol -> dave, used wherever depth matters.
    function chain() internal {
        bind(alice, root);
        bind(bob, alice);
        bind(carol, bob);
        bind(dave, carol);
    }

    // ---------------------------------------------------------------- shape

    function test_RootIsRegisteredFromBirth() public view {
        assertTrue(registry.isRegistered(root));
        assertEq(registry.referrer(root), address(0));
        assertEq(registry.levelOf(root), 0);
        assertEq(registry.memberCount(), 0);
        assertEq(registry.owner(), owner);
    }

    function test_ConstructorRejectsZeroes() public {
        vm.expectRevert(bytes("root=0"));
        new ReferralRegistry(address(0), owner);

        vm.expectRevert(bytes("owner=0"));
        new ReferralRegistry(root, address(0));
    }

    function test_BindRecordsTheEdge() public {
        vm.expectEmit(true, true, false, false);
        emit Bound(alice, root);
        bind(alice, root);

        assertEq(registry.referrer(alice), root);
        assertEq(registry.levelOf(alice), 1);
        assertEq(registry.directCount(root), 1);
        assertEq(registry.memberCount(), 1);
        assertTrue(registry.isRegistered(alice));
    }

    function test_LevelGrowsWithTheChain() public {
        chain();
        assertEq(registry.levelOf(alice), 1);
        assertEq(registry.levelOf(bob), 2);
        assertEq(registry.levelOf(carol), 3);
        assertEq(registry.levelOf(dave), 4);
        assertEq(registry.directCount(alice), 1);
        assertEq(registry.memberCount(), 4);
    }

    // ---------------------------------------------------------------- refusals

    function test_CannotBindTwice() public {
        bind(alice, root);
        bind(bob, root);
        vm.prank(alice);
        vm.expectRevert(bytes("already bound"));
        registry.bind(bob);
    }

    function test_CannotReferSelf() public {
        vm.prank(alice);
        vm.expectRevert(bytes("self referral"));
        registry.bind(alice);
    }

    function test_CannotBindToSomeoneOutsideTheTree() public {
        vm.prank(alice);
        vm.expectRevert(bytes("referrer not in tree"));
        registry.bind(bob);
    }

    function test_RootCannotBind() public {
        bind(alice, root);
        vm.prank(root);
        vm.expectRevert(bytes("already bound"));
        registry.bind(alice);
    }

    function test_BindingCannotCloseALoop() public {
        chain();
        // A binding is written once, so nobody can point back up their own chain.
        vm.prank(alice);
        vm.expectRevert(bytes("already bound"));
        registry.bind(dave);
    }

    // ---------------------------------------------------------------- corrections

    function test_OwnerCanMoveAMemberToAnotherUpline() public {
        bind(alice, root);
        bind(bob, root);
        bind(carol, alice); // carol meant to join under bob

        vm.expectEmit(true, true, true, false);
        emit ReferrerCorrected(carol, alice, bob);
        correct(carol, bob);

        assertEq(registry.referrer(carol), bob);
        assertEq(registry.directCount(alice), 0, "lost the direct");
        assertEq(registry.directCount(bob), 1, "gained it");
        assertEq(registry.memberCount(), 3, "a move is not a new member");
    }

    /// Why level is walked rather than stored: moving one member relevels everyone beneath them.
    function test_MovingAMemberRelevelsTheirWholeDownline() public {
        chain(); // root -> alice -> bob -> carol -> dave
        assertEq(registry.levelOf(dave), 4);

        correct(bob, root); // bob and everything under him move up two
        assertEq(registry.levelOf(bob), 1);
        assertEq(registry.levelOf(carol), 2);
        assertEq(registry.levelOf(dave), 3);

        address[] memory up = registry.uplineOf(dave, 10);
        assertEq(up.length, 3);
        assertEq(up[0], carol);
        assertEq(up[1], bob);
        assertEq(up[2], root);
    }

    function test_OnlyTheOwnerMayCorrect() public {
        bind(alice, root);
        bind(bob, root);

        vm.prank(alice);
        vm.expectRevert(bytes("not owner"));
        registry.correctReferrer(alice, bob);
    }

    function test_CorrectionRefusals() public {
        bind(alice, root);
        bind(bob, alice);

        vm.startPrank(owner);

        vm.expectRevert(bytes("user not bound"));
        registry.correctReferrer(carol, alice); // never joined

        vm.expectRevert(bytes("user not bound"));
        registry.correctReferrer(root, alice); // the root has no upline to correct

        vm.expectRevert(bytes("self referral"));
        registry.correctReferrer(bob, bob);

        vm.expectRevert(bytes("no change"));
        registry.correctReferrer(bob, alice);

        vm.expectRevert(bytes("referrer not in tree"));
        registry.correctReferrer(bob, dave); // dave never joined

        vm.stopPrank();
    }

    /// The reason this function needs a loop at all: rewriting an edge can splice a branch into
    /// itself, and then upline walks and team totals are both nonsense.
    function test_CorrectionCannotCreateACycle() public {
        chain(); // root -> alice -> bob -> carol -> dave

        vm.startPrank(owner);

        vm.expectRevert(bytes("would create a cycle"));
        registry.correctReferrer(alice, bob); // under its own child

        vm.expectRevert(bytes("would create a cycle"));
        registry.correctReferrer(alice, dave); // under a distant descendant

        vm.expectRevert(bytes("would create a cycle"));
        registry.correctReferrer(bob, carol);

        vm.stopPrank();

        // Moving sideways or upwards is still allowed.
        bind(erin, root);
        correct(dave, erin);
        assertEq(registry.referrer(dave), erin);
    }

    // ---------------------------------------------------------------- ownership

    function test_OwnershipTransferTakesTwoSteps() public {
        bind(alice, root);
        bind(bob, root);

        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferStarted(owner, alice);
        vm.prank(owner);
        registry.transferOwnership(alice);

        assertEq(registry.owner(), owner, "not until accepted");
        assertEq(registry.pendingOwner(), alice);

        vm.prank(bob);
        vm.expectRevert(bytes("not pending owner"));
        registry.acceptOwnership();

        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(owner, alice);
        vm.prank(alice);
        registry.acceptOwnership();

        assertEq(registry.owner(), alice);
        assertEq(registry.pendingOwner(), address(0));

        vm.prank(owner);
        vm.expectRevert(bytes("not owner"));
        registry.correctReferrer(bob, alice);
    }

    function test_RenouncingEndsCorrectionsForGood() public {
        bind(alice, root);
        bind(bob, root);
        bind(carol, alice);

        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(owner, address(0));
        vm.prank(owner);
        registry.renounceOwnership();

        assertEq(registry.owner(), address(0));
        assertEq(registry.pendingOwner(), address(0));

        vm.prank(owner);
        vm.expectRevert(bytes("not owner"));
        registry.correctReferrer(carol, bob);

        // And nobody can claim it afterwards, because only an owner can nominate.
        vm.prank(alice);
        vm.expectRevert(bytes("not owner"));
        registry.transferOwnership(alice);
    }

    function test_RenouncingClearsAPendingNomination() public {
        vm.startPrank(owner);
        registry.transferOwnership(alice);
        registry.renounceOwnership();
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(bytes("not pending owner"));
        registry.acceptOwnership();
    }

    // ---------------------------------------------------------------- views

    function test_UplineOfWalksToTheRoot() public {
        chain();
        address[] memory up = registry.uplineOf(carol, 10);
        assertEq(up.length, 3, "stops at the root instead of padding");
        assertEq(up[0], bob);
        assertEq(up[1], alice);
        assertEq(up[2], root);
    }

    function test_UplineOfRespectsTheLimit() public {
        chain();
        address[] memory up = registry.uplineOf(carol, 2);
        assertEq(up.length, 2);
        assertEq(up[0], bob);
        assertEq(up[1], alice);

        assertEq(registry.uplineOf(carol, 0).length, 0);
        assertEq(registry.uplineOf(erin, 5).length, 0, "an unbound address has no upline");
        assertEq(registry.uplineOf(carol, type(uint256).max).length, 3, "a silly limit is capped");
    }

    function test_StatusOf() public {
        bind(alice, root);
        bind(bob, alice);

        (bool registered, address upline, uint32 level, uint32 directs) = registry.statusOf(alice);
        assertTrue(registered);
        assertEq(upline, root);
        assertEq(level, 1);
        assertEq(directs, 1);

        (registered, upline, level, directs) = registry.statusOf(erin);
        assertFalse(registered);
        assertEq(upline, address(0));
        assertEq(level, 0);
        assertEq(directs, 0);
    }

    // ---------------------------------------------------------------- limits and gas

    /// A walk has to stop somewhere. Past the cap the views refuse rather than run forever.
    function test_WalksRefuseBeyondTheCap() public {
        uint256 cap = registry.MAX_LEVELS();
        address cursor = root;
        address last;
        for (uint256 i = 1; i <= cap; ++i) {
            address next = address(uint160(0x100000 + i));
            vm.prank(next);
            registry.bind(cursor);
            if (i == cap - 1) last = next;
            cursor = next;
        }

        assertEq(registry.levelOf(last), uint32(cap - 1), "the deepest answerable level");

        vm.expectRevert(bytes("chain too long"));
        registry.levelOf(cursor);
    }

    /// Unlimited levels have to stay affordable, or the tree stops growing on its own.
    function test_JoiningCostsTheSameAtAnyDepth() public {
        bind(alice, root);
        address cursor = alice;
        for (uint256 i; i < 200; ++i) {
            // safe: i is bounded by the loop at 200, nowhere near uint160
            // forge-lint: disable-next-line(unsafe-typecast)
            address next = address(uint160(0x10000 + i));
            vm.prank(next);
            registry.bind(cursor);
            cursor = next;
        }
        assertEq(registry.levelOf(cursor), 201);

        address shallow = makeAddr("shallow");
        vm.prank(shallow);
        uint256 gasBefore = gasleft();
        registry.bind(root);
        uint256 shallowCost = gasBefore - gasleft();

        address deep = makeAddr("deep");
        vm.prank(deep);
        gasBefore = gasleft();
        registry.bind(cursor);
        uint256 deepCost = gasBefore - gasleft();

        // Same storage writes either way; the only difference is whether directCount is cold.
        assertApproxEqAbs(deepCost, shallowCost, 25_000, "depth must not make joining dearer");
    }

    // ---------------------------------------------------------------- properties

    function testFuzz_LevelIsAlwaysOneAboveTheUpline(address[10] calldata people) public {
        address cursor = root;
        uint32 expected;
        for (uint256 i; i < people.length; ++i) {
            address person = people[i];
            if (person == address(0) || registry.isRegistered(person) || person == cursor) continue;
            vm.prank(person);
            registry.bind(cursor);
            unchecked {
                ++expected;
            }
            assertEq(registry.levelOf(person), expected);
            assertEq(registry.referrer(person), cursor);
            cursor = person;
        }
    }

    /// However the owner shuffles people around, everybody still chains up to the root. Whatever
    /// the contract lets through has to leave a tree behind.
    function testFuzz_CorrectionsAlwaysLeaveATree(uint8[16] calldata picks) public {
        address[5] memory people = [alice, bob, carol, dave, erin];
        bind(alice, root);
        bind(bob, alice);
        bind(carol, bob);
        bind(dave, carol);
        bind(erin, dave);

        for (uint256 i; i + 1 < picks.length; i += 2) {
            address user = people[picks[i] % people.length];
            address up = people[picks[i + 1] % people.length];
            vm.prank(owner);
            try registry.correctReferrer(user, up) {} catch {}
        }

        for (uint256 i; i < people.length; ++i) {
            address cursor = people[i];
            uint256 steps;
            while (cursor != root) {
                cursor = registry.referrer(cursor);
                assertTrue(cursor != address(0), "fell out of the tree");
                assertLt(++steps, people.length + 2, "walked in a circle");
            }
        }
        assertEq(registry.memberCount(), 5, "corrections never add or remove members");
    }
}
