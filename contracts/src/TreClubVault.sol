// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The TreClub views TreClubVault relies on.
interface ITreClubView {
    function clubCount() external view returns (uint256);
    function isAdmin(uint256 clubId, address account) external view returns (bool);
    function isMember(uint256 clubId, address account) external view returns (bool);
}

/// @title TreClubVault — shared private folders for TreClub clubs.
/// @notice Companion to an existing TreClub (which keeps its members and admins). For each club it stores:
///         - the shared private folder: an opaque descriptor (owner wallet, Keysmith group key id and group,
///           data set id, providers, volume) that tells members where the folder lives;
///         - per member, a Keysmith Delivery: the folder's group key wrapped (ECDH secp256k1) to the member's
///           published TrePerson wrap key, plus a read claim naming the member's key as bearer. Only the member,
///           who can re-derive that key from a wallet signature, can unwrap it;
///         - per member, a directory entry (their TrePerson identity link) encrypted under the folder key.
///         Everything here is public chain data; secrets are only ever stored encrypted. Removing a delivery
///         does not un-share a key the member already read: rotate the folder (new group) for that.
/// @dev Write access to the folder's data set (PDP session keys in SessionKeyRegistry) is granted by the data
///      set's payer wallet in the same Accept flow; this contract records who was accepted with which key.
contract TreClubVault {
    struct Grant {
        address memberKey; // the member's derived key address (claim bearer and PDP session key)
        uint64 updatedAt;
        address by; // admin who wrote it
        bytes delivery; // Keysmith Delivery bytes
        bytes entry; // directory entry, encrypted under the folder key
    }

    ITreClubView public immutable club;

    mapping(uint256 => bytes) private _folder;
    mapping(uint256 => uint256) public folderVersion;
    mapping(uint256 => mapping(address => Grant)) private _grants;

    event FolderSet(uint256 indexed clubId, address indexed by, uint256 version, bytes descriptor);
    event MemberGranted(uint256 indexed clubId, address indexed member, address indexed memberKey, address by, uint256 folderVersion);
    event MemberRevoked(uint256 indexed clubId, address indexed member, address indexed by);

    error NoClub();
    error NotAdmin();
    error NotInClub();
    error ZeroAddress();
    error Empty();
    error TooLarge();

    uint256 public constant MAX_BYTES = 4096;

    constructor(ITreClubView club_) {
        if (address(club_) == address(0)) revert ZeroAddress();
        club = club_;
    }

    modifier onlyAdmin(uint256 clubId) {
        if (clubId == 0 || clubId > club.clubCount()) revert NoClub();
        if (!club.isAdmin(clubId, msg.sender)) revert NotAdmin();
        _;
    }

    /// @notice Point the club at its shared private folder (or a rotated one). Bumps the folder version.
    function setFolder(uint256 clubId, bytes calldata descriptor) external onlyAdmin(clubId) {
        if (descriptor.length == 0) revert Empty();
        if (descriptor.length > MAX_BYTES) revert TooLarge();
        _folder[clubId] = descriptor;
        uint256 v = ++folderVersion[clubId];
        emit FolderSet(clubId, msg.sender, v, descriptor);
    }

    /// @notice Accept step: store the folder key, wrapped to `memberKey`, for a member or admin of the club.
    function grant(uint256 clubId, address member, address memberKey, bytes calldata delivery, bytes calldata entry)
        external
        onlyAdmin(clubId)
    {
        if (member == address(0) || memberKey == address(0)) revert ZeroAddress();
        if (!club.isMember(clubId, member) && !club.isAdmin(clubId, member)) revert NotInClub();
        if (delivery.length == 0) revert Empty();
        if (delivery.length > MAX_BYTES || entry.length > MAX_BYTES) revert TooLarge();
        _grants[clubId][member] = Grant(memberKey, uint64(block.timestamp), msg.sender, delivery, entry);
        emit MemberGranted(clubId, member, memberKey, msg.sender, folderVersion[clubId]);
    }

    /// @notice Drop a member's stored delivery (e.g. after TreClub.removeMember). Does not revoke a key already read.
    function revoke(uint256 clubId, address member) external onlyAdmin(clubId) {
        delete _grants[clubId][member];
        emit MemberRevoked(clubId, member, msg.sender);
    }

    function folderOf(uint256 clubId) external view returns (bytes memory descriptor, uint256 version) {
        return (_folder[clubId], folderVersion[clubId]);
    }

    function grantOf(uint256 clubId, address member) external view returns (Grant memory) {
        return _grants[clubId][member];
    }

    /// @notice Grants for a page of members (pair with TreClub.listMembers / listAdmins for the directory).
    function grantsOf(uint256 clubId, address[] calldata members) external view returns (Grant[] memory out) {
        out = new Grant[](members.length);
        for (uint256 i = 0; i < members.length; i++) out[i] = _grants[clubId][members[i]];
    }
}
