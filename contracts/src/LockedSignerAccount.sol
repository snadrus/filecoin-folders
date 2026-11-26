// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Minimal EIP-1167 clone + signature recovery (no OpenZeppelin dependency in this repo).
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

interface IFilecoinPayL {
    function setOperatorApproval(address, address, bool, uint256, uint256, uint256) external;
    function withdrawTo(address token, address to, uint256 amount) external;
    function settleRail(uint256 railId, uint256 untilEpoch) external;
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
/// @notice Per-user Filecoin Pay / FWSS payer that a signature-only wallet drives, but cannot drain.
///  - The user key may sign FWSS AddPieces / SchedulePieceRemovals / TerminateService (session key).
///  - The user key may NOT sign CreateDataSet. The sponsor (factory admin, the "money processor") opens each
///    data set once through `allowDataSet`, which pins the payee to an FWSS-approved provider and authorizes
///    exactly one CreateDataSet message via a keyless "Nick's method" signer (same trick as FWSS
///    ExampleSponsoredDataSet). This blocks paying a self-run SP.
///  - The owner may add browser session keys (`addSessionKey`, owner-signed execute only). A session key gets the
///    same FWSS scopes as the owner and may sign `execute` for the policy below, except calls to this account.
///  - `execute` (user-signed, relayed) only reaches a fixed policy: FWSS terminateService, Filecoin Pay
///    settleRail, SessionKeyRegistry revoke, add/removeSessionKey (owner only), and admin-allowlisted app contracts
///    (e.g. FolderRegistry). Filecoin Pay withdraw/operator changes and any call to the payment token are
///    hard-blocked and cannot be allowlisted. Calls may not carry value.
///  - Unspent funds leave only via `sweep`, callable by the factory admin (treasury) to the treasury.
contract LockedSignerAccount {
    error AlreadyInitialized();
    error NotFactory();
    error NotAdmin();
    error NotSelf();
    error Expired(uint256 deadline);
    error BadNonce(uint256 expected, uint256 got);
    error BadSigner(address recovered);
    error CallNotAllowed(address target, bytes4 selector);
    error ValueNotAllowed();
    error ProviderNotApproved(uint256 providerId);
    error CallFailed(bytes returndata);

    event Executed(uint256 indexed nonce, address indexed target, bytes4 selector);
    event DataSetAllowed(uint256 indexed providerId, address payee, uint256 clientDataSetId, address createSigner);
    event Swept(address to, uint256 amount);
    event SessionKey(address indexed key, uint256 expiry);

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

    // Fixed signature used for keyless CreateDataSet authorization (Nick's method): r = s = 1, v = 27.
    bytes32 public constant NICK_R = bytes32(uint256(1));
    bytes32 public constant NICK_S = bytes32(uint256(1));
    uint8 public constant NICK_V = 27;

    bytes4 private constant TERMINATE_SERVICE_1 = bytes4(keccak256("terminateService(uint256)"));
    bytes4 private constant TERMINATE_SERVICE_2 = bytes4(keccak256("terminateService(uint256,bytes)"));

    LockedSignerAccountFactory public immutable FACTORY;

    address public owner;
    uint256 public nonce;
    uint256 public sessionExpiry;
    /// @notice Browser session keys allowed to sign `execute` (expiry, unix seconds).
    mapping(address => uint256) public sessionSigners;

    constructor() {
        FACTORY = LockedSignerAccountFactory(msg.sender);
        owner = address(0xdead);
    }

    function initialize(address owner_, uint256 sessionExpiry_) external {
        if (msg.sender != address(FACTORY)) revert NotFactory();
        if (owner != address(0)) revert AlreadyInitialized();
        owner = owner_;
        sessionExpiry = sessionExpiry_;
        IFWSSL fwss = IFWSSL(FACTORY.FWSS());
        IFilecoinPayL(FACTORY.PAY()).setOperatorApproval(
            FACTORY.TOKEN(), address(fwss), true, type(uint256).max, type(uint256).max, type(uint256).max
        );
        ISessionKeyRegistryL(FACTORY.SKR()).login(owner_, sessionExpiry_, _fwssScopes(), "fil-gasless-locked");
    }

    // ---------------------------------------------------------------- user path (relayed)

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

    /// @notice True if a user-signed execute may call `target.selector`.
    function isAllowed(address target, bytes4 selector) public view returns (bool) {
        LockedSignerAccountFactory f = FACTORY;
        if (target == address(this)) return selector == this.addSessionKey.selector || selector == this.removeSessionKey.selector;
        if (target == f.TOKEN()) return false; // no transfer / approve / permit / anything on the payment token
        if (target == f.PAY()) return selector == IFilecoinPayL.settleRail.selector; // no withdraw, no operator changes
        if (target == f.FWSS()) return selector == TERMINATE_SERVICE_1 || selector == TERMINATE_SERVICE_2;
        if (target == f.SKR()) return selector == ISessionKeyRegistryL.revoke.selector; // no new keys / scopes
        return f.appAllowed(target, selector);
    }

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
        address signer = LockedLib.recover(executeDigest(target, value, data, nonce_, deadline), signature);
        if (signer != owner && (target == address(this) || sessionSigners[signer] < block.timestamp)) {
            revert BadSigner(signer);
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

    /// @notice Owner-signed (via execute): let a browser key sign FWSS piece ops and allowlisted executes.
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
    ///         Sponsor (factory admin) only: data set creation is a one-time backend step. The SP submits the creation with the fixed
    ///         signature (r=s=1, v=27); no key exists for the derived signer, so nothing else can be signed.
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
        ISessionKeyRegistryL(FACTORY.SKR()).login(createSigner, sessionExpiry, perms, "fil-gasless-locked");
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

    // ---------------------------------------------------------------- treasury path

    /// @notice Return unspent Filecoin Pay funds to the treasury. Admin only; destination is fixed.
    function sweep(uint256 amount) external {
        if (msg.sender != FACTORY.admin()) revert NotAdmin();
        address treasury = FACTORY.treasury();
        IFilecoinPayL(FACTORY.PAY()).withdrawTo(FACTORY.TOKEN(), treasury, amount);
        emit Swept(treasury, amount);
    }
}

/// @title LockedSignerAccountFactory
/// @notice Permissionless CREATE2 deployment; admin (sponsor) manages the app allowlist and treasury sweeps.
contract LockedSignerAccountFactory {
    error NotAdmin();
    error ProtectedTarget(address target);

    event AccountCreated(address indexed account, address indexed owner, uint256 salt);
    event AppAllowed(address indexed target, bytes4 indexed selector, bool allowed);

    LockedSignerAccount public immutable IMPLEMENTATION;
    address public immutable FWSS;
    address public immutable PAY;
    address public immutable SKR;
    address public immutable TOKEN;
    address public admin;
    address public treasury;
    mapping(address => mapping(bytes4 => bool)) public appAllowed;

    constructor(address fwss, address admin_, address treasury_) {
        FWSS = fwss;
        PAY = IFWSSL(fwss).paymentsContractAddress();
        SKR = IFWSSL(fwss).sessionKeyRegistry();
        TOKEN = IFWSSL(fwss).usdfcTokenAddress();
        admin = admin_;
        treasury = treasury_;
        IMPLEMENTATION = new LockedSignerAccount();
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @notice Allow app contracts (e.g. FolderRegistry.commitFor, FiClub writes). Core contracts cannot be added.
    function setAppAllowed(address target, bytes4 selector, bool allowed) external onlyAdmin {
        if (target == FWSS || target == PAY || target == SKR || target == TOKEN || target.code.length == 0) {
            revert ProtectedTarget(target);
        }
        appAllowed[target][selector] = allowed;
        emit AppAllowed(target, selector, allowed);
    }

    function setAdmin(address next) external onlyAdmin {
        admin = next;
    }

    function setTreasury(address next) external onlyAdmin {
        treasury = next;
    }

    function _salt(address owner, uint256 salt, uint256 sessionExpiry) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt, sessionExpiry));
    }

    function predict(address owner, uint256 salt, uint256 sessionExpiry) public view returns (address) {
        return LockedLib.predict(address(IMPLEMENTATION), _salt(owner, salt, sessionExpiry), address(this));
    }

    function create(address owner, uint256 salt, uint256 sessionExpiry) external returns (LockedSignerAccount account) {
        address predicted = predict(owner, salt, sessionExpiry);
        if (predicted.code.length > 0) return LockedSignerAccount(predicted);
        account = LockedSignerAccount(LockedLib.clone(address(IMPLEMENTATION), _salt(owner, salt, sessionExpiry)));
        account.initialize(owner, sessionExpiry);
        emit AccountCreated(address(account), owner, salt);
    }
}
