// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ReferralRegistry} from "../contracts/ReferralRegistry.sol";

/// @notice Deploys the referral registry.
///
///   forge script script/Deploy.s.sol --rpc-url bsc                        # simulate only
///   forge script script/Deploy.s.sol --rpc-url bsc --broadcast --verify   # for real
///
/// ROOT, OWNER and PRIVATE_KEY are read from .env, which forge loads by itself. The key is read
/// here rather than passed as --private-key so that it never appears on a command line, where any
/// process on the machine can list it.
///
/// ROOT is the top of the tree: the project's own address, the one everybody ultimately chains up
/// to. It is immutable, so get it right the first time.
///
/// OWNER may correct a binding somebody made by mistake, and nothing else -- there are no funds to
/// touch. It does not have to be the deployer, and often should not be: deploy with a hot key and
/// own with a safe one. It can be handed over later (two-step) or given up for good.
///
/// The private key lives only in .env, which is git-ignored; it is never read from the repository.
contract Deploy is Script {
    function run() external {
        address root = vm.envAddress("ROOT");
        address owner = vm.envAddress("OWNER");
        uint256 key = vm.envUint("PRIVATE_KEY");
        require(root != address(0), "set ROOT");
        require(owner != address(0), "set OWNER");

        console.log("chain   ", block.chainid);
        console.log("deployer", vm.addr(key));
        console.log("root    ", root);
        console.log("owner   ", owner);

        vm.startBroadcast(key);
        ReferralRegistry registry = new ReferralRegistry(root, owner);
        vm.stopBroadcast();

        console.log("");
        console.log("ReferralRegistry", address(registry));
        console.log("");
        console.log("Next: put the address into web/app.js CONFIG.registry and");
        console.log("      REGISTRY_ADDRESS for the indexer.");
    }
}
