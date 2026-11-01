// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeployBase} from "./DeployBase.sol";
import {FolderRegistry} from "../src/FolderRegistry.sol";

/// @notice Deploy FolderRegistry to Filecoin Calibration (chain id 314159).
/// @dev RPC: https://api.calibration.node.glif.io/rpc/v1
///      PRIVATE_KEY=0x... forge script script/DeployCalibration.s.sol:DeployCalibration --root contracts --rpc-url calibration --broadcast
contract DeployCalibration is DeployBase {
    function run() external returns (FolderRegistry) {
        return _deploy(314159);
    }
}
