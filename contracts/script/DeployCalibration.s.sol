// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeployBase} from "./DeployBase.sol";
import {FolderRegistry} from "../src/FolderRegistry.sol";

/// @notice Deploy FolderRegistry to Filecoin Calibration (chain id 314159).
/// @dev RPC: https://api.calibration.node.glif.io/rpc/v1
///      SessionKeyRegistry: 0x518411c2062E119Aaf7A8B12A2eDf9a939347655
///      Prefer `pnpm deploy:calibration` (forge create). forge script simulation
///      underestimates FEVM gas and the broadcast fails.
contract DeployCalibration is DeployBase {
    address internal constant SESSION_KEY_REGISTRY = 0x518411c2062E119Aaf7A8B12A2eDf9a939347655;

    function run() external returns (FolderRegistry) {
        return _deploy(314159, SESSION_KEY_REGISTRY);
    }
}
