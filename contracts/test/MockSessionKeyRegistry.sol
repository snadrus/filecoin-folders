// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test double for Filecoin's SessionKeyRegistry. The public mapping getter
///         matches `authorizationExpiry(address,address,bytes32)`.
contract MockSessionKeyRegistry {
    mapping(address => mapping(address => mapping(bytes32 => uint256))) public authorizationExpiry;

    function setExpiry(address user, address signer, bytes32 permission, uint256 expiry) external {
        authorizationExpiry[user][signer][permission] = expiry;
    }
}
