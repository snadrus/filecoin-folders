// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeployBase} from "./DeployBase.sol";
import {FolderRegistry} from "../src/FolderRegistry.sol";

/// @notice Deploy FolderRegistry to Filecoin mainnet (chain id 314).
/// @dev RPC: https://api.node.glif.io/rpc/v1
///      SessionKeyRegistry: 0x74FD50525A958aF5d484601E252271f9625231aB
///      Prefer `pnpm deploy:mainnet` (forge create).
contract DeployMainnet is DeployBase {
    address internal constant SESSION_KEY_REGISTRY = 0x74FD50525A958aF5d484601E252271f9625231aB;

    function run() external returns (FolderRegistry) {
        return _deploy(314, SESSION_KEY_REGISTRY);
    }
}
