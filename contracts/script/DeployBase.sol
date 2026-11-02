// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FolderRegistry} from "../src/FolderRegistry.sol";

/// @notice Shared deployer. Reads PRIVATE_KEY from the environment and does not log it.
/// @dev Constructor args are the deployer (admin) and that chain's SessionKeyRegistry.
///      `forge script` simulation underestimates FEVM gas. Deploy with `forge create`
///      (`pnpm deploy:calibration` / `pnpm deploy:mainnet`), which uses eth_estimateGas.
abstract contract DeployBase is Script {
    function _deploy(uint256 expectedChainId, address sessionKeyRegistry) internal returns (FolderRegistry registry) {
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
        if (sessionKeyRegistry == address(0)) revert("session key registry is zero");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address admin = vm.addr(pk);
        vm.startBroadcast(pk);
        registry = new FolderRegistry(admin, sessionKeyRegistry);
        vm.stopBroadcast();
        console2.log("FolderRegistry", address(registry));
        console2.log("admin", admin);
        console2.log("sessionKeyRegistry", sessionKeyRegistry);
        console2.log("chainId", block.chainid);
    }
}
