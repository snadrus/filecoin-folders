// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Minimal Ownable, ERC-1967 beacon, and BeaconProxy (OpenZeppelin-compatible slot).
///      Vendored OZ in this repo is a P256/Base64 subset only, so these live here.

error NotOwner();
error NotContract();
error ZeroOwner();

interface IBeacon {
    function implementation() external view returns (address);
}

contract Ownable {
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public owner;

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroOwner();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwnership(address newOwner) public onlyOwner {
        if (newOwner == address(0)) revert ZeroOwner();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}

/// @notice Upgradeable beacon whose owner can point every BeaconProxy at a new implementation.
contract UpgradeableBeacon is Ownable, IBeacon {
    event Upgraded(address indexed implementation);

    address private _implementation;

    constructor(address implementation_, address initialOwner) Ownable(initialOwner) {
        _set(implementation_);
    }

    function implementation() public view returns (address) {
        return _implementation;
    }

    function upgradeTo(address newImplementation) external onlyOwner {
        _set(newImplementation);
    }

    function _set(address newImplementation) private {
        if (newImplementation.code.length == 0) revert NotContract();
        _implementation = newImplementation;
        emit Upgraded(newImplementation);
    }
}

/// @notice ERC-1967 beacon proxy. Beacon address lives in the standard slot; calls delegate to beacon.implementation().
contract BeaconProxy {
    /// @dev bytes32(uint256(keccak256("eip1967.proxy.beacon")) - 1)
    bytes32 private constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    constructor(address beacon, bytes memory data) payable {
        if (beacon.code.length == 0) revert NotContract();
        assembly {
            sstore(BEACON_SLOT, beacon)
        }
        if (data.length > 0) {
            (bool ok, bytes memory ret) = IBeacon(beacon).implementation().delegatecall(data);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }

    fallback() external payable {
        _fallback();
    }

    receive() external payable {
        _fallback();
    }

    function _fallback() private {
        address impl = IBeacon(_beacon()).implementation();
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    function _beacon() private view returns (address b) {
        assembly {
            b := sload(BEACON_SLOT)
        }
    }
}
