// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title FolderRegistry
/// @notice Compare-and-swap register of opaque Filecoin piece CIDs.
/// @dev One head per `(owner, ns, key)`. Not upgradeable: there is no proxy,
///      initializer, or owner-controlled implementation slot. The contract does
///      not call Filecoin syscalls; it is plain EVM and deploys on FEVM.
///
///      Heads start empty (`pieceCid = ""`, `version = 0`). Each successful
///      commit stores `pieceCid` only when `prevPieceCid` hashes equal to the
///      current head, then increments `version` by one. Callers typically pass
///      the UTF-8 PieceCID. The namespace and key are chosen by the caller;
///      `fil-folders` uses `keccak256("fil-folders")` and `keccak256(volumeName)`.
contract FolderRegistry {
    /// @notice Maximum accepted piece-CID payload. Real PieceCIDs are shorter.
    uint256 public constant MAX_PIECE_CID_BYTES = 128;

    struct Head {
        bytes pieceCid;
        uint64 version;
    }

    /// @dev owner => ns => key => head. Mappings sit in slots 0 and 1.
    mapping(address => mapping(bytes32 => mapping(bytes32 => Head))) private _heads;

    /// @dev owner => ns => writer => approved. The owner is always authorized.
    mapping(address => mapping(bytes32 => mapping(address => bool))) private _writers;

    /// @notice `prevPieceCid` did not match the head. `currentVersion` is the head's version.
    error CasConflict(bytes currentPieceCid, uint64 currentVersion);

    /// @notice `caller` may not commit for `owner` in `ns`.
    error NotAuthorized(address caller, address owner, bytes32 ns);

    /// @notice `owner` or `writer` was the zero address.
    error ZeroAddress();

    /// @notice A piece CID argument was longer than {MAX_PIECE_CID_BYTES}.
    error PieceCidTooLarge(uint256 length);

    /// @notice The version counter cannot advance past `type(uint64).max`.
    error VersionOverflow();

    /// @notice A head was replaced. `version` is the value stored by this commit.
    event Committed(
        address indexed owner,
        bytes32 indexed ns,
        bytes32 indexed key,
        bytes pieceCid,
        bytes prevPieceCid,
        uint64 version,
        uint256 timestamp
    );

    /// @notice A namespace writer was approved or revoked by `owner`.
    event WriterSet(address indexed owner, bytes32 indexed ns, address indexed writer, bool allowed);

    /// @notice Commit a new head owned by the caller.
    /// @param ns Namespace chosen by the caller.
    /// @param key Key chosen by the caller. Unique per owner and namespace.
    /// @param pieceCid New head payload. Empty bytes clears the payload.
    /// @param prevPieceCid Current head the caller observed. Empty when the head has never been set.
    function commit(bytes32 ns, bytes32 key, bytes calldata pieceCid, bytes calldata prevPieceCid) external {
        _commit(msg.sender, ns, key, pieceCid, prevPieceCid);
    }

    /// @notice Commit a new head for `owner`.
    /// @dev The caller must be `owner` or a writer `owner` approved for `ns`.
    function commitFor(
        address owner,
        bytes32 ns,
        bytes32 key,
        bytes calldata pieceCid,
        bytes calldata prevPieceCid
    ) external {
        if (owner == address(0)) revert ZeroAddress();
        if (msg.sender != owner && !_writers[owner][ns][msg.sender]) {
            revert NotAuthorized(msg.sender, owner, ns);
        }
        _commit(owner, ns, key, pieceCid, prevPieceCid);
    }

    /// @notice Approve or revoke `writer` for a namespace owned by the caller.
    /// @param allowed `true` grants commitFor, `false` revokes it.
    function setWriter(bytes32 ns, address writer, bool allowed) external {
        if (writer == address(0)) revert ZeroAddress();
        _writers[msg.sender][ns][writer] = allowed;
        emit WriterSet(msg.sender, ns, writer, allowed);
    }

    /// @notice Current head for `(owner, ns, key)`.
    /// @return pieceCid Empty when nothing has been committed.
    /// @return version Zero when nothing has been committed. Otherwise the number of successful commits.
    function head(address owner, bytes32 ns, bytes32 key) external view returns (bytes memory pieceCid, uint64 version) {
        Head storage h = _heads[owner][ns][key];
        return (h.pieceCid, h.version);
    }

    /// @notice Whether `writer` may `commitFor` `owner` in `ns`. The owner is always authorized.
    function isWriter(address owner, bytes32 ns, address writer) external view returns (bool) {
        return writer == owner || _writers[owner][ns][writer];
    }

    function _commit(
        address owner,
        bytes32 ns,
        bytes32 key,
        bytes calldata pieceCid,
        bytes calldata prevPieceCid
    ) private {
        if (pieceCid.length > MAX_PIECE_CID_BYTES) revert PieceCidTooLarge(pieceCid.length);
        if (prevPieceCid.length > MAX_PIECE_CID_BYTES) revert PieceCidTooLarge(prevPieceCid.length);

        Head storage h = _heads[owner][ns][key];
        bytes memory current = h.pieceCid;
        if (keccak256(current) != keccak256(prevPieceCid)) {
            revert CasConflict(current, h.version);
        }
        if (h.version == type(uint64).max) revert VersionOverflow();

        h.pieceCid = pieceCid;
        unchecked {
            h.version += 1;
        }

        emit Committed(owner, ns, key, pieceCid, prevPieceCid, h.version, block.timestamp);
    }
}
