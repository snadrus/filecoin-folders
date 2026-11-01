// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeployBase} from "./DeployBase.sol";
import {FolderRegistry} from "../src/FolderRegistry.sol";

/// @notice Deploy FolderRegistry to Filecoin mainnet (chain id 314).
/// @dev RPC: https://api.node.glif.io/rpc/v1
///      PRIVATE_KEY=0x... forge script script/DeployMainnet.s.sol:DeployMainnet --root contracts --rpc-url filecoin --broadcast
contract DeployMainnet is DeployBase {
    function run() external returns (FolderRegistry) {
        return _deploy(314);
    }
}
