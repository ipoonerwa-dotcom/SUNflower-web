// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ReferralRegistry
/// @notice The referral tree for SUNFLOWER (0xfd06eeAdC43ee0687D5611d698Fb2Ee39f9BAAAa).
///
/// @dev This contract stores who introduced whom, and nothing else. It holds no funds and pays no
///      rewards. Team performance is computed off chain from PancakeSwap and lending-vault events,
///      and rewards are reviewed and paid by hand. That separation is deliberate: on-chain
///      automatic referral rewards have been drained before, and a registry with no money in it
///      has nothing to drain.
///
///      A member writes their own binding, once, by sending the transaction themselves. Nobody can
///      bind anybody else, and nobody can rewrite their own binding afterwards.
///
///      The owner is the single exception, and it exists for one reason: people paste the wrong
///      address or follow the wrong link, and without `correctReferrer` those mistakes would be
///      permanent. The power is real and is stated here rather than buried -- whoever holds the
///      owner key can move any member under any upline, which is the same as deciding who gets
///      credited for whose purchases. It is bounded in three ways: it cannot touch balances because
///      there are none, every use is an event anybody can read, and it can be given up for good
///      with `renounceOwnership`. Transfer is two-step, so a mistyped address cannot lose it.
///
///      Why the graph stays a tree: `bind` only ever attaches an unregistered address as a new leaf
///      under one already in the tree, so it cannot close a loop. `correctReferrer` could, because
///      it rewrites an existing edge, so it walks up from the proposed upline first and refuses if
///      it arrives at the member being moved.
///
///      Level is derived, not stored. Moving one member changes the level of everything beneath
///      them, and a stored number would go stale silently.
contract ReferralRegistry {
    /// @notice How far any walk up the tree will go before refusing to answer. Far past any real
    ///         referral chain; it is here so that a view can never run forever and a correction can
    ///         never cost unbounded gas.
    uint256 public constant MAX_LEVELS = 512;

    /// @notice The top of the tree. Registered from birth; cannot itself be bound or moved.
    /// @dev Lower case on purpose: this is the public getter the front end calls as `root()`, so
    ///      the style rule for immutables would change the ABI rather than just the source.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable root;

    /// @notice May correct a mistaken binding, and nothing else.
    address public owner;

    /// @notice Nominated by `transferOwnership`; becomes owner only by calling `acceptOwnership`.
    address public pendingOwner;

    /// @notice Who introduced this address. Zero for the root and for anyone not yet bound.
    mapping(address => address) public referrer;

    /// @notice How many addresses this one introduced directly.
    mapping(address => uint32) public directCount;

    /// @notice Total bindings written, i.e. everyone in the tree except the root. A correction
    ///         moves a member rather than adding one, so it does not change this.
    uint256 public memberCount;

    event Bound(address indexed user, address indexed referrer);
    event ReferrerCorrected(address indexed user, address indexed from, address indexed to);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    /// @param root_ The top of the tree. Permanent.
    /// @param owner_ Who may correct mistakes. Need not be the deployer, and may later be dropped.
    constructor(address root_, address owner_) {
        require(root_ != address(0), "root=0");
        require(owner_ != address(0), "owner=0");
        root = root_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    // ------------------------------------------------------------------ members

    /// @notice Join the tree under `referrer_`. One way, once per address, gas paid by the joiner
    ///         so the binding is unambiguously their own decision.
    function bind(address referrer_) external {
        require(!isRegistered(msg.sender), "already bound");
        require(referrer_ != msg.sender, "self referral");
        require(isRegistered(referrer_), "referrer not in tree");

        referrer[msg.sender] = referrer_;
        unchecked {
            ++directCount[referrer_];
            ++memberCount;
        }
        emit Bound(msg.sender, referrer_);
    }

    // ------------------------------------------------------------------ owner

    /// @notice Move a member under a different upline. Meant for mistakes -- a wrong address, the
    ///         wrong invite link -- and every use stays permanently visible as an event.
    /// @dev The member keeps their own downline; only the edge above them moves.
    function correctReferrer(address user, address newReferrer) external onlyOwner {
        address current = referrer[user];
        require(current != address(0), "user not bound");
        require(newReferrer != user, "self referral");
        require(newReferrer != current, "no change");
        require(isRegistered(newReferrer), "referrer not in tree");
        // Walking up from the proposed upline must not run into the member being moved, or the
        // branch would be spliced into itself and the graph would stop being a tree.
        require(!_reaches(newReferrer, user), "would create a cycle");

        referrer[user] = newReferrer;
        unchecked {
            // `current` counts `user` among its directs, so this cannot go below zero.
            --directCount[current];
            ++directCount[newReferrer];
        }
        emit ReferrerCorrected(user, current, newReferrer);
    }

    /// @notice Nominate the next owner. Takes effect only when they call `acceptOwnership`.
    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    /// @notice Accept a nomination made by the current owner.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Give up the power to correct bindings, permanently. Afterwards the tree is writable
    ///         only by members binding themselves, and no key can move anybody's upline again.
    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------------ views

    /// @notice Whether this address is part of the tree and may be referred to.
    function isRegistered(address account) public view returns (bool) {
        return account == root || referrer[account] != address(0);
    }

    /// @notice Distance from the root: 0 for the root, 1 for its direct members, and so on.
    /// @dev Walked rather than stored, so that a correction cannot leave a stale number behind.
    function levelOf(address account) public view returns (uint32 level) {
        address cursor = account;
        for (uint256 step; step < MAX_LEVELS; ++step) {
            address up = referrer[cursor];
            if (up == address(0)) return level;
            cursor = up;
            unchecked {
                ++level;
            }
        }
        revert("chain too long");
    }

    /// @notice The chain of introducers above `account`, nearest first, ending at the root.
    /// @param levels How many to return at most, capped at MAX_LEVELS.
    /// @return chain The uplines found, shortened to however many actually exist.
    function uplineOf(address account, uint256 levels) external view returns (address[] memory chain) {
        if (levels > MAX_LEVELS) levels = MAX_LEVELS;
        address[] memory buffer = new address[](levels);
        uint256 found;
        address cursor = account;
        while (found < levels) {
            address up = referrer[cursor];
            if (up == address(0)) break;
            buffer[found] = up;
            unchecked {
                ++found;
            }
            cursor = up;
        }
        chain = new address[](found);
        for (uint256 i; i < found; ++i) {
            chain[i] = buffer[i];
        }
    }

    /// @notice Everything the UI needs about one address in a single call.
    function statusOf(address account)
        external
        view
        returns (bool registered, address upline, uint32 level, uint32 directs)
    {
        return (isRegistered(account), referrer[account], levelOf(account), directCount[account]);
    }

    /// @dev True if walking up from `from` arrives at `target`, counting `from` itself.
    function _reaches(address from, address target) private view returns (bool) {
        address cursor = from;
        for (uint256 step; step < MAX_LEVELS; ++step) {
            if (cursor == target) return true;
            address up = referrer[cursor];
            if (up == address(0)) return false; // the root, or not in the tree at all
            cursor = up;
        }
        revert("chain too long");
    }
}
