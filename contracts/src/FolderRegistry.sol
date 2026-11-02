// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Filecoin SessionKeyRegistry. `expiry >= block.timestamp` means `signer` may act for `user`.
interface ISessionKeyRegistry {
    function authorizationExpiry(address user, address signer, bytes32 permission) external view returns (uint256);
}

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
///
///      A session key commits with `commitFor`. `msg.sender` must be the volume
///      owner, an approved writer, or a signer whose SessionKeyRegistry
///      authorization for {PERMISSION_COMMIT} has not expired. The head stays
///      under the volume owner, not the session key.
contract FolderRegistry {
    /// @notice Maximum accepted piece-CID payload. Real PieceCIDs are shorter.
    uint256 public constant MAX_PIECE_CID_BYTES = 128;

    /// @notice Permission a session key must hold to `commitFor` its root wallet.
    /// @dev `keccak256("fil-folders.commit")`.
    bytes32 public constant PERMISSION_COMMIT = keccak256("fil-folders.commit");

    struct Head {
        bytes pieceCid;
        uint64 version;
    }

    /// @dev owner => ns => key => head. This mapping stays in slot 0.
    mapping(address => mapping(bytes32 => mapping(bytes32 => Head))) private _heads;

    /// @dev owner => ns => writer => approved. The owner is always authorized. Slot 1.
    mapping(address => mapping(bytes32 => mapping(address => bool))) private _writers;

    /// @notice Admin. May replace {sessionKeyRegistry}. Not a volume owner.
    address public owner;

    /// @notice Registry that records session-key permissions. Set by {owner}.
    ISessionKeyRegistry public sessionKeyRegistry;

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

    /// @notice Caller is not {owner}.
    error NotContractOwner();

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

    event OwnerUpdated(address indexed previousOwner, address indexed nextOwner);

    event SessionKeyRegistryUpdated(address indexed previousRegistry, address indexed nextRegistry);

    /// @param initialOwner Admin for {setSessionKeyRegistry}. Not a volume owner.
    /// @param initialSessionKeyRegistry Filecoin SessionKeyRegistry for this chain.
    constructor(address initialOwner, address initialSessionKeyRegistry) {
        if (initialOwner == address(0) || initialSessionKeyRegistry == address(0)) revert ZeroAddress();
        owner = initialOwner;
        sessionKeyRegistry = ISessionKeyRegistry(initialSessionKeyRegistry);
        emit OwnerUpdated(address(0), initialOwner);
        emit SessionKeyRegistryUpdated(address(0), initialSessionKeyRegistry);
    }

    /// @notice Replace the admin.
    function setOwner(address nextOwner) external {
        if (msg.sender != owner) revert NotContractOwner();
        if (nextOwner == address(0)) revert ZeroAddress();
        address prev = owner;
        owner = nextOwner;
        emit OwnerUpdated(prev, nextOwner);
    }

    /// @notice Point session-key checks at a new SessionKeyRegistry.
    function setSessionKeyRegistry(address nextRegistry) external {
        if (msg.sender != owner) revert NotContractOwner();
        if (nextRegistry == address(0)) revert ZeroAddress();
        address prev = address(sessionKeyRegistry);
        sessionKeyRegistry = ISessionKeyRegistry(nextRegistry);
        emit SessionKeyRegistryUpdated(prev, nextRegistry);
    }

    /// @notice Commit a new head owned by the caller.
    /// @param ns Namespace chosen by the caller.
    /// @param key Key chosen by the caller. Unique per owner and namespace.
    /// @param pieceCid New head payload. Empty bytes clears the payload.
    /// @param prevPieceCid Current head the caller observed. Empty when the head has never been set.
    function commit(bytes32 ns, bytes32 key, bytes calldata pieceCid, bytes calldata prevPieceCid) external {
        _commit(msg.sender, ns, key, pieceCid, prevPieceCid);
    }

    /// @notice Commit a new head for `volumeOwner`.
    /// @dev The caller must be `volumeOwner`, a writer approved for `ns`, or a session key
    ///      authorized for `volumeOwner` on {PERMISSION_COMMIT} through {block.timestamp}.
    function commitFor(
        address volumeOwner,
        bytes32 ns,
        bytes32 key,
        bytes calldata pieceCid,
        bytes calldata prevPieceCid
    ) external {
        if (volumeOwner == address(0)) revert ZeroAddress();
        if (msg.sender != volumeOwner && !_writers[volumeOwner][ns][msg.sender] && !_sessionAuthorized(volumeOwner)) {
            revert NotAuthorized(msg.sender, volumeOwner, ns);
        }
        _commit(volumeOwner, ns, key, pieceCid, prevPieceCid);
    }

    /// @notice Approve or revoke `writer` for a namespace owned by the caller.
    /// @param allowed `true` grants commitFor, `false` revokes it.
    function setWriter(bytes32 ns, address writer, bool allowed) external {
        if (writer == address(0)) revert ZeroAddress();
        _writers[msg.sender][ns][writer] = allowed;
        emit WriterSet(msg.sender, ns, writer, allowed);
    }

    /// @notice Current head for `(volumeOwner, ns, key)`.
    /// @return pieceCid Empty when nothing has been committed.
    /// @return version Zero when nothing has been committed. Otherwise the number of successful commits.
    function head(address volumeOwner, bytes32 ns, bytes32 key)
        external
        view
        returns (bytes memory pieceCid, uint64 version)
    {
        Head storage h = _heads[volumeOwner][ns][key];
        return (h.pieceCid, h.version);
    }

    /// @notice Whether `writer` may `commitFor` `volumeOwner` in `ns`. The owner is always authorized.
    /// @dev Session keys are not writers. They pass the SessionKeyRegistry check inside {commitFor}.
    function isWriter(address volumeOwner, bytes32 ns, address writer) external view returns (bool) {
        return writer == volumeOwner || _writers[volumeOwner][ns][writer];
    }

    function _sessionAuthorized(address volumeOwner) private view returns (bool) {
        uint256 expiry = sessionKeyRegistry.authorizationExpiry(volumeOwner, msg.sender, PERMISSION_COMMIT);
        return expiry >= block.timestamp;
    }

    function _commit(
        address volumeOwner,
        bytes32 ns,
        bytes32 key,
        bytes calldata pieceCid,
        bytes calldata prevPieceCid
    ) private {
        if (pieceCid.length > MAX_PIECE_CID_BYTES) revert PieceCidTooLarge(pieceCid.length);
        if (prevPieceCid.length > MAX_PIECE_CID_BYTES) revert PieceCidTooLarge(prevPieceCid.length);

        Head storage h = _heads[volumeOwner][ns][key];
        bytes memory current = h.pieceCid;
        if (keccak256(current) != keccak256(prevPieceCid)) {
            revert CasConflict(current, h.version);
        }
        if (h.version == type(uint64).max) revert VersionOverflow();

        h.pieceCid = pieceCid;
        unchecked {
            h.version += 1;
        }

        emit Committed(volumeOwner, ns, key, pieceCid, prevPieceCid, h.version, block.timestamp);
    }
}
