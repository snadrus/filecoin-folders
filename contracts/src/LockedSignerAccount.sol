// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @dev Minimal EIP-1167 clone + secp256k1 recovery.
library LockedLib {
    error BadSignature();

    function cloneCode(address impl) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3");
    }

    function predict(address impl, bytes32 salt, address deployer) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, keccak256(cloneCode(impl)))))));
    }

    function clone(address impl, bytes32 salt) internal returns (address instance) {
        bytes memory code = cloneCode(impl);
        assembly {
            instance := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(instance != address(0), "clone failed");
    }

    function recover(bytes32 digest, bytes calldata sig) internal pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}

/// @dev WebAuthn (passkey) assertion check: P-256 over sha256(authenticatorData || sha256(clientDataJSON)), with the
///      challenge bound into clientDataJSON. Filecoin has no RIP-7212 precompile (0x100), so P256.verify runs in Solidity.
library LockedWebAuthn {
    struct Assertion {
        bytes authenticatorData;
        string clientDataJSON;
        uint256 challengeIndex;
        uint256 typeIndex;
        bytes32 r;
        bytes32 s;
    }

    function verify(bytes32 challenge, Assertion memory a, bytes32 qx, bytes32 qy) internal view returns (bool) {
        bytes memory json = bytes(a.clientDataJSON);
        if (a.authenticatorData.length < 37 || (uint8(a.authenticatorData[32]) & 0x01) == 0) return false; // user present
        if (!_at(json, a.typeIndex, bytes('"type":"webauthn.get"'))) return false;
        bytes memory want = abi.encodePacked('"challenge":"', Base64.encodeURL(abi.encodePacked(challenge)), '"');
        if (!_at(json, a.challengeIndex, want)) return false;
        bytes32 h = sha256(abi.encodePacked(a.authenticatorData, sha256(json)));
        return P256.verify(h, a.r, a.s, qx, qy);
    }

    function _at(bytes memory haystack, uint256 index, bytes memory needle) private pure returns (bool) {
        if (index + needle.length > haystack.length) return false;
        for (uint256 i; i < needle.length; i++) {
            if (haystack[index + i] != needle[i]) return false;
        }
        return true;
    }
}

interface IFilecoinPayL {
    function setOperatorApproval(address, address, bool, uint256, uint256, uint256) external;
    function withdrawTo(address token, address to, uint256 amount) external;
}

interface IERC20L {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IFilecoinPayDepositL {
    function deposit(address token, address to, uint256 amount) external payable;
}

interface ISessionKeyRegistryL {
    function login(address signer, uint256 expiry, bytes32[] calldata permissions, string calldata origin) external;
    function revoke(address signer, bytes32[] calldata permissions, string calldata origin) external;
}

interface IFWSSL {
    function paymentsContractAddress() external view returns (address);
    function sessionKeyRegistry() external view returns (address);
    function usdfcTokenAddress() external view returns (address);
    function serviceProviderRegistry() external view returns (address);
    function isProviderApproved(uint256 providerId) external view returns (bool);
    function eip712Domain()
        external
        view
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory);
}

interface ISPRegistryL {
    function getProviderPayee(uint256 providerId) external view returns (address);
}

/// @title LockedSignerAccount
/// @notice Per-user Filecoin Pay / FWSS payer that a signature-only wallet (secp256k1 EOA or WebAuthn passkey) drives,
///         but cannot drain.
///  - Owner-signed or session-key-signed `execute` reaches a FIXED policy, compiled in and not admin-extendable:
///      * FWSS.terminateService(uint256)                 end storage (the only FWSS call a payer makes itself)
///      * FolderRegistryV2.commit(bytes32,bytes32,bytes,uint64) at the factory's immutable REGISTRY (0 disables):
///        a non-upgradeable pointer store with no token logic and no outbound calls
///      * this.addSessionKey / this.removeSessionKey     owner signature only
///    Everything else reverts: Filecoin Pay (withdraw, operator changes, settle), the payment token, SessionKeyRegistry
///    (beyond what add/removeSessionKey do), PDPVerifier, any other contract. Calls may not carry value.
///  - Piece adds and removals are never sent by the account: session keys sign FWSS AddPieces / SchedulePieceRemovals
///    and the provider submits them.
///  - Data sets are opened once by the sponsor (factory admin) via `allowDataSet`, pinned to an FWSS-approved provider.
///  - Unspent funds leave only via `sweep`, admin-only, to the factory treasury.
contract LockedSignerAccount {
    error AlreadyInitialized();
    error NotFactory();
    error NotAdmin();
    error NotSelf();
    error Expired(uint256 deadline);
    error BadNonce(uint256 expected, uint256 got);
    error BadSigner(address recovered);
    error BadPasskeySignature();
    error CallNotAllowed(address target, bytes4 selector);
    error ValueNotAllowed();
    error ProviderNotApproved(uint256 providerId);
    error CallFailed(bytes returndata);
    error NotUnassigned();
    error NoOwner();

    event Executed(uint256 indexed nonce, address indexed target, bytes4 selector);
    event DataSetAllowed(uint256 indexed providerId, address payee, uint256 clientDataSetId, address createSigner);
    event Swept(address to, uint256 amount);
    event SessionKey(address indexed key, uint256 expiry);
    event OwnerAssigned(address indexed owner, bytes32 passkeyX, bytes32 passkeyY);

    bytes32 public constant EXECUTE_TYPEHASH =
        keccak256("Execute(address target,uint256 value,bytes data,uint256 nonce,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public constant CREATE_DATA_SET = keccak256(
        "CreateDataSet(uint256 clientDataSetId,address payee,MetadataEntry[] metadata)MetadataEntry(string key,string value)"
    );
    bytes32 public constant ADD_PIECES = keccak256(
        "AddPieces(uint256 clientDataSetId,uint256 nonce,Cid[] pieceData,PieceMetadata[] pieceMetadata)"
        "Cid(bytes data)" "MetadataEntry(string key,string value)"
        "PieceMetadata(uint256 pieceIndex,MetadataEntry[] metadata)"
    );
    bytes32 public constant SCHEDULE_PIECE_REMOVALS =
        keccak256("SchedulePieceRemovals(uint256 clientDataSetId,uint256[] pieceIds)");
    bytes32 public constant TERMINATE_SERVICE = keccak256("TerminateService(uint256 dataSetId)");
    bytes32 private constant METADATA_ENTRY_TYPEHASH = keccak256("MetadataEntry(string key,string value)");

    bytes32 public constant NICK_R = bytes32(uint256(1));
    bytes32 public constant NICK_S = bytes32(uint256(1));
    uint8 public constant NICK_V = 27;

    bytes4 public constant TERMINATE_SERVICE_SELECTOR = bytes4(keccak256("terminateService(uint256)"));
    bytes4 public constant REGISTRY_COMMIT_SELECTOR = bytes4(keccak256("commit(bytes32,bytes32,bytes,uint64)"));

    LockedSignerAccountFactory public immutable FACTORY;

    /// @notice secp256k1 owner (zero when the owner is a passkey).
    address public owner;
    /// @notice P-256 passkey owner public key (zero when the owner is an EOA).
    bytes32 public passkeyX;
    bytes32 public passkeyY;
    uint256 public nonce;
    uint256 public sessionExpiry;
    /// @notice Browser session keys allowed to sign `execute` (expiry, unix seconds).
    mapping(address => uint256) public sessionSigners;
    /// @notice Warm-pool account created without an owner; `assignOwner` sets one exactly once. Nobody can sign
    ///         `execute` while this is true.
    bool public unassigned;
    bool private _initialized;

    constructor() {
        FACTORY = LockedSignerAccountFactory(msg.sender);
        _initialized = true;
    }

    function initialize(address owner_, bytes32 qx, bytes32 qy, uint256 sessionExpiry_) external {
        if (msg.sender != address(FACTORY)) revert NotFactory();
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        owner = owner_;
        passkeyX = qx;
        passkeyY = qy;
        sessionExpiry = sessionExpiry_;
        unassigned = owner_ == address(0) && qx == bytes32(0);
        IFilecoinPayL(FACTORY.PAY()).setOperatorApproval(
            FACTORY.TOKEN(), FACTORY.FWSS(), true, type(uint256).max, type(uint256).max, type(uint256).max
        );
        // An EOA owner may sign FWSS piece ops directly; a passkey cannot (FWSS verifies secp256k1 only).
        if (owner_ != address(0)) ISessionKeyRegistryL(FACTORY.SKR()).login(owner_, sessionExpiry_, _fwssScopes(), "fifolders");
    }

    /// @notice One-shot handover of a warm-pool account to its buyer. Factory only (its `assign` is admin-only), only
    ///         while unassigned, never again afterwards. The call policy is unchanged by assignment.
    function assignOwner(address owner_, bytes32 qx, bytes32 qy) external {
        if (msg.sender != address(FACTORY)) revert NotFactory();
        if (!unassigned) revert NotUnassigned();
        if (owner_ == address(0) && qx == bytes32(0)) revert NoOwner();
        unassigned = false;
        owner = owner_;
        passkeyX = qx;
        passkeyY = qy;
        if (owner_ != address(0)) ISessionKeyRegistryL(FACTORY.SKR()).login(owner_, sessionExpiry, _fwssScopes(), "fifolders");
        emit OwnerAssigned(owner_, qx, qy);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("LockedSignerAccount"), keccak256("1"), block.chainid, address(this))
        );
    }

    function executeDigest(address target, uint256 value, bytes calldata data, uint256 nonce_, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(EXECUTE_TYPEHASH, target, value, keccak256(data), nonce_, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice True if a signed execute may call `target.selector`. Fixed at deploy; nobody can widen it.
    function isAllowed(address target, bytes4 selector) public view returns (bool) {
        if (target == address(this)) return selector == this.addSessionKey.selector || selector == this.removeSessionKey.selector;
        if (target == FACTORY.FWSS()) return selector == TERMINATE_SERVICE_SELECTOR;
        address registry = FACTORY.REGISTRY();
        if (registry != address(0) && target == registry) return selector == REGISTRY_COMMIT_SELECTOR;
        return false;
    }

    /// @param signature 65-byte secp256k1 (owner or session key), or abi.encode(LockedWebAuthn.Assertion) (passkey owner).
    function execute(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 nonce_,
        uint256 deadline,
        bytes calldata signature
    ) external returns (bytes memory result) {
        if (block.timestamp > deadline) revert Expired(deadline);
        if (nonce_ != nonce) revert BadNonce(nonce, nonce_);
        if (value != 0) revert ValueNotAllowed();
        bytes4 selector = bytes4(data);
        if (!isAllowed(target, selector)) revert CallNotAllowed(target, selector);
        bytes32 digest = executeDigest(target, value, data, nonce_, deadline);
        if (signature.length == 65) {
            address signer = LockedLib.recover(digest, signature);
            bool isOwner = signer == owner && signer != address(0);
            if (!isOwner && (target == address(this) || sessionSigners[signer] < block.timestamp)) revert BadSigner(signer);
        } else {
            if (passkeyX == bytes32(0)) revert BadPasskeySignature();
            LockedWebAuthn.Assertion memory a = abi.decode(signature, (LockedWebAuthn.Assertion));
            if (!LockedWebAuthn.verify(digest, a, passkeyX, passkeyY)) revert BadPasskeySignature();
        }
        nonce = nonce_ + 1;
        bool ok;
        (ok, result) = target.call(data);
        if (!ok) revert CallFailed(result);
        emit Executed(nonce_, target, selector);
    }

    function _fwssScopes() private pure returns (bytes32[] memory perms) {
        perms = new bytes32[](3);
        perms[0] = ADD_PIECES;
        perms[1] = SCHEDULE_PIECE_REMOVALS;
        perms[2] = TERMINATE_SERVICE;
    }

    /// @notice Owner-signed (via execute): let a browser secp256k1 key sign FWSS piece ops and policy executes.
    function addSessionKey(address key, uint256 expiry) external {
        if (msg.sender != address(this)) revert NotSelf();
        if (expiry > sessionExpiry) expiry = sessionExpiry;
        sessionSigners[key] = expiry;
        ISessionKeyRegistryL(FACTORY.SKR()).login(key, expiry, _fwssScopes(), "fifolders");
        emit SessionKey(key, expiry);
    }

    function removeSessionKey(address key) external {
        if (msg.sender != address(this)) revert NotSelf();
        delete sessionSigners[key];
        ISessionKeyRegistryL(FACTORY.SKR()).revoke(key, _fwssScopes(), "fifolders");
        emit SessionKey(key, 0);
    }

    /// @notice Authorize exactly one CreateDataSet(clientDataSetId, payee, metadata) with an FWSS-approved provider.
    ///         Sponsor (factory admin) only. The provider submits it with the fixed signature (r=s=1, v=27); no key
    ///         exists for the derived signer, so nothing else can be signed with it.
    function allowDataSet(uint256 providerId, uint256 clientDataSetId, string[] calldata keys, string[] calldata values)
        external
        returns (address createSigner)
    {
        if (msg.sender != FACTORY.admin()) revert NotAdmin();
        IFWSSL fwss = IFWSSL(FACTORY.FWSS());
        if (!fwss.isProviderApproved(providerId)) revert ProviderNotApproved(providerId);
        address payee = ISPRegistryL(fwss.serviceProviderRegistry()).getProviderPayee(providerId);
        createSigner = createDataSetSigner(clientDataSetId, payee, keys, values);
        bytes32[] memory perms = new bytes32[](1);
        perms[0] = CREATE_DATA_SET;
        ISessionKeyRegistryL(FACTORY.SKR()).login(createSigner, sessionExpiry, perms, "fifolders");
        emit DataSetAllowed(providerId, payee, clientDataSetId, createSigner);
    }

    function createDataSetSigner(uint256 clientDataSetId, address payee, string[] calldata keys, string[] calldata values)
        public
        view
        returns (address)
    {
        require(keys.length == values.length, "metadata length");
        bytes32[] memory entries = new bytes32[](keys.length);
        for (uint256 i; i < keys.length; i++) {
            entries[i] = keccak256(abi.encode(METADATA_ENTRY_TYPEHASH, keccak256(bytes(keys[i])), keccak256(bytes(values[i]))));
        }
        bytes32 structHash =
            keccak256(abi.encode(CREATE_DATA_SET, clientDataSetId, payee, keccak256(abi.encodePacked(entries))));
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            IFWSSL(FACTORY.FWSS()).eip712Domain();
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifyingContract)
        );
        return ecrecover(keccak256(abi.encodePacked("\x19\x01", domain, structHash)), NICK_V, NICK_R, NICK_S);
    }

    /// @notice Return unspent Filecoin Pay funds to the treasury. Admin only; destination is fixed.
    function sweep(uint256 amount) external {
        if (msg.sender != FACTORY.admin()) revert NotAdmin();
        address treasury = FACTORY.treasury();
        IFilecoinPayL(FACTORY.PAY()).withdrawTo(FACTORY.TOKEN(), treasury, amount);
        emit Swept(treasury, amount);
    }
}

/// @title LockedSignerAccountFactory
/// @notice Permissionless CREATE2 deployment and a registry of its accounts (`isAccount`). The admin (sponsor) opens
///         data sets and sweeps to the treasury; it cannot change any account's call policy.
contract LockedSignerAccountFactory {
    error NotAdmin();
    error NoOwner();

    event AccountCreated(address indexed account, address indexed owner, bytes32 passkeyX, uint256 salt);
    event AccountAssigned(address indexed account, address indexed owner, bytes32 passkeyX, uint256 topUp);
    error NotAccount(address account);

    LockedSignerAccount public immutable IMPLEMENTATION;
    address public immutable FWSS;
    address public immutable PAY;
    address public immutable SKR;
    address public immutable TOKEN;
    /// @notice FolderRegistryV2 whose `commit` accounts may call (zero: none). Immutable.
    address public immutable REGISTRY;
    address public admin;
    address public treasury;
    mapping(address => bool) public isAccount;

    constructor(address fwss, address registry, address admin_, address treasury_) {
        FWSS = fwss;
        PAY = IFWSSL(fwss).paymentsContractAddress();
        SKR = IFWSSL(fwss).sessionKeyRegistry();
        TOKEN = IFWSSL(fwss).usdfcTokenAddress();
        REGISTRY = registry;
        admin = admin_;
        treasury = treasury_;
        IMPLEMENTATION = new LockedSignerAccount();
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    function setAdmin(address next) external onlyAdmin {
        admin = next;
    }

    function setTreasury(address next) external onlyAdmin {
        treasury = next;
    }

    function _salt(address owner, bytes32 qx, bytes32 qy, uint256 salt, uint256 sessionExpiry) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, qx, qy, salt, sessionExpiry));
    }

    function predict(address owner, bytes32 qx, bytes32 qy, uint256 salt, uint256 sessionExpiry) public view returns (address) {
        return LockedLib.predict(address(IMPLEMENTATION), _salt(owner, qx, qy, salt, sessionExpiry), address(this));
    }

    /// @param owner secp256k1 owner, or zero with (qx, qy) a P-256 passkey public key.
    function create(address owner, bytes32 qx, bytes32 qy, uint256 salt, uint256 sessionExpiry)
        external
        returns (LockedSignerAccount account)
    {
        if (owner == address(0) && qx == bytes32(0)) revert NoOwner();
        address predicted = predict(owner, qx, qy, salt, sessionExpiry);
        if (predicted.code.length > 0) return LockedSignerAccount(predicted);
        account = LockedSignerAccount(LockedLib.clone(address(IMPLEMENTATION), _salt(owner, qx, qy, salt, sessionExpiry)));
        isAccount[address(account)] = true;
        account.initialize(owner, qx, qy, sessionExpiry);
        emit AccountCreated(address(account), owner, qx, salt);
    }

    /// @notice Warm pool: an ownerless account the admin pre-funds and opens a data set for, then hands to a buyer.
    function createPooled(uint256 salt, uint256 sessionExpiry) external onlyAdmin returns (LockedSignerAccount account) {
        bytes32 key = _salt(address(0), bytes32(0), bytes32(0), salt, sessionExpiry);
        account = LockedSignerAccount(LockedLib.clone(address(IMPLEMENTATION), key));
        isAccount[address(account)] = true;
        account.initialize(address(0), bytes32(0), bytes32(0), sessionExpiry);
        emit AccountCreated(address(account), address(0), bytes32(0), salt);
    }

    /// @notice One transaction: assign a pooled account's owner (once) and deposit `topUp` of the admin's tokens into
    ///         it in Filecoin Pay (admin must have approved this factory for `topUp`).
    function assign(LockedSignerAccount account, address owner, bytes32 qx, bytes32 qy, uint256 topUp) external onlyAdmin {
        if (!isAccount[address(account)]) revert NotAccount(address(account));
        account.assignOwner(owner, qx, qy);
        if (topUp > 0) {
            require(IERC20L(TOKEN).transferFrom(msg.sender, address(this), topUp), "transferFrom");
            IERC20L(TOKEN).approve(PAY, topUp);
            IFilecoinPayDepositL(PAY).deposit(TOKEN, address(account), topUp);
        }
        emit AccountAssigned(address(account), owner, qx, topUp);
    }
}
