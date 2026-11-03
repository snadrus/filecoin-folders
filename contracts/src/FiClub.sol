// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title FiClub — on-chain groups (clubs) with two explicit lists: members and admins.
/// @notice Admins manage both lists. Removing an admin while the club has more than two admins
///         needs EIP-712 signatures from two distinct current admins (the target may be one of them).
///         The last admin can never be removed. Admins are NOT implicitly members: the lists are separate
///         (the creator is put on both).
contract FiClub {
    struct Club {
        string name;
        bytes metadata; // optional piece CID bytes
        address creator;
        uint64 createdAt;
        uint256 nonce; // RemoveAdmin replay protection
    }

    struct AddrSet {
        address[] items;
        mapping(address => uint256) pos; // index + 1
    }

    struct IdSet {
        uint256[] items;
        mapping(uint256 => uint256) pos;
    }

    bytes32 public constant REMOVE_ADMIN_TYPEHASH =
        keccak256("RemoveAdmin(uint256 clubId,address target,uint256 nonce,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    uint256 public clubCount;
    mapping(uint256 => Club) private _clubs;
    mapping(uint256 => AddrSet) private _members;
    mapping(uint256 => AddrSet) private _admins;
    mapping(address => IdSet) private _clubsOf; // clubs where address is member or admin

    event ClubCreated(uint256 indexed clubId, address indexed creator, string name, bytes metadata);
    event ClubUpdated(uint256 indexed clubId, address indexed by, string name, bytes metadata);
    event MemberAdded(uint256 indexed clubId, address indexed account, address indexed by);
    event MemberRemoved(uint256 indexed clubId, address indexed account, address indexed by);
    event AdminAdded(uint256 indexed clubId, address indexed account, address indexed by);
    event AdminRemoved(uint256 indexed clubId, address indexed account, address indexed by);
    event AdminRemovedBySignatures(uint256 indexed clubId, address indexed account, address signer1, address signer2, uint256 nonce);

    error NoClub();
    error NotAdmin();
    error AlreadyMember();
    error NotMember();
    error AlreadyAdmin();
    error NotAnAdmin();
    error LastAdmin();
    error NeedSignatures();
    error TooFewAdminsForSignatures();
    error Expired();
    error BadSignature();
    error DuplicateSigner();
    error SignerNotAdmin();
    error ZeroAddress();

    modifier exists(uint256 clubId) {
        if (clubId == 0 || clubId > clubCount) revert NoClub();
        _;
    }

    modifier onlyAdmin(uint256 clubId) {
        if (clubId == 0 || clubId > clubCount) revert NoClub();
        if (_admins[clubId].pos[msg.sender] == 0) revert NotAdmin();
        _;
    }

    // ---------- writes ----------

    function createClub(string calldata name, bytes calldata metadata) external returns (uint256 clubId) {
        clubId = ++clubCount;
        Club storage c = _clubs[clubId];
        c.name = name;
        c.metadata = metadata;
        c.creator = msg.sender;
        c.createdAt = uint64(block.timestamp);
        emit ClubCreated(clubId, msg.sender, name, metadata);
        _add(_admins[clubId], msg.sender);
        _add(_members[clubId], msg.sender);
        _clubsOf[msg.sender].items.push(clubId);
        _clubsOf[msg.sender].pos[clubId] = _clubsOf[msg.sender].items.length;
        emit AdminAdded(clubId, msg.sender, msg.sender);
        emit MemberAdded(clubId, msg.sender, msg.sender);
    }

    function updateClub(uint256 clubId, string calldata name, bytes calldata metadata) external onlyAdmin(clubId) {
        _clubs[clubId].name = name;
        _clubs[clubId].metadata = metadata;
        emit ClubUpdated(clubId, msg.sender, name, metadata);
    }

    function addMember(uint256 clubId, address account) external onlyAdmin(clubId) {
        if (account == address(0)) revert ZeroAddress();
        if (!_add(_members[clubId], account)) revert AlreadyMember();
        _index(clubId, account);
        emit MemberAdded(clubId, account, msg.sender);
    }

    function removeMember(uint256 clubId, address account) external onlyAdmin(clubId) {
        if (!_remove(_members[clubId], account)) revert NotMember();
        _unindex(clubId, account);
        emit MemberRemoved(clubId, account, msg.sender);
    }

    function addAdmin(uint256 clubId, address account) external onlyAdmin(clubId) {
        if (account == address(0)) revert ZeroAddress();
        if (!_add(_admins[clubId], account)) revert AlreadyAdmin();
        _index(clubId, account);
        emit AdminAdded(clubId, account, msg.sender);
    }

    /// @notice Direct removal, only while the club has at most two admins. Self-removal allowed; last admin never.
    function removeAdmin(uint256 clubId, address account) external onlyAdmin(clubId) {
        AddrSet storage a = _admins[clubId];
        if (a.pos[account] == 0) revert NotAnAdmin();
        if (a.items.length > 2) revert NeedSignatures();
        if (a.items.length == 1) revert LastAdmin();
        _remove(a, account);
        _unindex(clubId, account);
        emit AdminRemoved(clubId, account, msg.sender);
    }

    /// @notice Removal with two admin signatures (clubs with >2 admins). Anyone may submit.
    ///         The target may be one of the signers (an admin may co-sign their own removal).
    function removeAdminWithSignatures(
        uint256 clubId,
        address target,
        uint256 deadline,
        bytes calldata sig1,
        bytes calldata sig2
    ) external exists(clubId) {
        if (block.timestamp > deadline) revert Expired();
        AddrSet storage a = _admins[clubId];
        if (a.pos[target] == 0) revert NotAnAdmin();
        if (a.items.length <= 2) revert TooFewAdminsForSignatures();
        uint256 nonce = _clubs[clubId].nonce;
        bytes32 digest = removeAdminDigest(clubId, target, nonce, deadline);
        address s1 = _recover(digest, sig1);
        address s2 = _recover(digest, sig2);
        if (s1 == s2) revert DuplicateSigner();
        if (a.pos[s1] == 0 || a.pos[s2] == 0) revert SignerNotAdmin();
        _clubs[clubId].nonce = nonce + 1;
        _remove(a, target);
        _unindex(clubId, target);
        emit AdminRemoved(clubId, target, msg.sender);
        emit AdminRemovedBySignatures(clubId, target, s1, s2, nonce);
    }

    // ---------- views ----------

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("FiClub"), keccak256("1"), block.chainid, address(this)));
    }

    function removeAdminDigest(uint256 clubId, address target, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(REMOVE_ADMIN_TYPEHASH, clubId, target, nonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function getClub(uint256 clubId)
        external
        view
        exists(clubId)
        returns (string memory name, bytes memory metadata, address creator, uint64 createdAt, uint256 nonce)
    {
        Club storage c = _clubs[clubId];
        return (c.name, c.metadata, c.creator, c.createdAt, c.nonce);
    }

    function nonceOf(uint256 clubId) external view returns (uint256) { return _clubs[clubId].nonce; }
    function isMember(uint256 clubId, address account) external view returns (bool) { return _members[clubId].pos[account] != 0; }
    function isAdmin(uint256 clubId, address account) external view returns (bool) { return _admins[clubId].pos[account] != 0; }
    function memberCount(uint256 clubId) external view returns (uint256) { return _members[clubId].items.length; }
    function adminCount(uint256 clubId) external view returns (uint256) { return _admins[clubId].items.length; }

    function listMembers(uint256 clubId, uint256 offset, uint256 limit) external view returns (address[] memory) {
        return _page(_members[clubId].items, offset, limit);
    }

    function listAdmins(uint256 clubId, uint256 offset, uint256 limit) external view returns (address[] memory) {
        return _page(_admins[clubId].items, offset, limit);
    }

    /// @notice Clubs where `account` is a member or an admin (unordered after removals).
    function clubsOf(address account, uint256 offset, uint256 limit) external view returns (uint256[] memory out) {
        uint256[] storage ids = _clubsOf[account].items;
        uint256 n = offset >= ids.length ? 0 : ids.length - offset;
        if (n > limit) n = limit;
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = ids[offset + i];
    }

    function clubsOfCount(address account) external view returns (uint256) { return _clubsOf[account].items.length; }

    // ---------- internals ----------

    function _page(address[] storage items, uint256 offset, uint256 limit) private view returns (address[] memory out) {
        uint256 n = offset >= items.length ? 0 : items.length - offset;
        if (n > limit) n = limit;
        out = new address[](n);
        for (uint256 i; i < n; ++i) out[i] = items[offset + i];
    }

    function _add(AddrSet storage s, address a) private returns (bool) {
        if (s.pos[a] != 0) return false;
        s.items.push(a);
        s.pos[a] = s.items.length;
        return true;
    }

    function _remove(AddrSet storage s, address a) private returns (bool) {
        uint256 p = s.pos[a];
        if (p == 0) return false;
        address last = s.items[s.items.length - 1];
        s.items[p - 1] = last;
        s.pos[last] = p;
        s.items.pop();
        delete s.pos[a];
        return true;
    }

    function _index(uint256 clubId, address a) private {
        IdSet storage s = _clubsOf[a];
        if (s.pos[clubId] != 0) return;
        s.items.push(clubId);
        s.pos[clubId] = s.items.length;
    }

    function _unindex(uint256 clubId, address a) private {
        if (_members[clubId].pos[a] != 0 || _admins[clubId].pos[a] != 0) return;
        IdSet storage s = _clubsOf[a];
        uint256 p = s.pos[clubId];
        if (p == 0) return;
        uint256 last = s.items[s.items.length - 1];
        s.items[p - 1] = last;
        s.pos[last] = p;
        s.items.pop();
        delete s.pos[clubId];
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if ((v != 27 && v != 28) || uint256(s) > HALF_N) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}
