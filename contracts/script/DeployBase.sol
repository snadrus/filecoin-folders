// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FolderRegistry} from "../src/FolderRegistry.sol";

/// @notice Shared deployer. Reads PRIVATE_KEY from the environment and does not log it.
abstract contract DeployBase is Script {
    function _deploy(uint256 expectedChainId) internal returns (FolderRegistry registry) {
        if (block.chainid != expectedChainId) {
            revert(
                string.concat(
                    "unexpected chain id ",
                    vm.toString(block.chainid),
                    ", expected ",
                    vm.toString(expectedChainId)
                )
            );
        }
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        registry = new FolderRegistry();
        vm.stopBroadcast();
        console2.log("FolderRegistry", address(registry));
        console2.log("chainId", block.chainid);
    }
}
