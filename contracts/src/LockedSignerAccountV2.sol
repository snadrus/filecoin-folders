// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    LockedLib,
    LockedWebAuthn,
    IFilecoinPayL,
    IERC20L,
    IFilecoinPayDepositL,
    ISessionKeyRegistryL,
    IFWSSL,
    ISPRegistryL
} from "./LockedSignerAccount.sol";
import {BeaconProxy, UpgradeableBeacon} from "./beacon/Beacon.sol";

/// @title LockedSignerAccountV2
/// @notice Upgradeable (beacon proxy) per-user payer. Existing v1 clones stay on the immutable v1 implementation.
///
/// Two workflows:
///  (a) Owner-signed (EOA or passkey P-256) calls that move value (USDFC, Filecoin Pay deposits, operator and
///      rate approvals) may target only the payment/storage allowlist (Filecoin Pay, FWSS, and the payment token
///      when the spender/recipient is Pay or FWSS). Withdrawals are not owner-callable. The only other exit is
///      the admin `sweep` to the factory treasury. Funds never go to the user or any other address.
///  (b) Session-key Execute may call any contract, but only if it moves no funds: zero value; blocked ERC-20
///      transfer/transferFrom/approve/increaseAllowance/permit and every Filecoin Pay deposit, withdraw and
///      approval selector; and the target may not be the token or Filecoin Pay (no spending an existing allowance).
///  addSessionKey / removeSessionKey remain owner-only (via execute).
contract LockedSignerAccountV2 {
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
    error BadAllowanceTarget();

    event Executed(uint256 indexed nonce, address indexed target, bytes4 selector, bool ownerSigned);
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

    // ERC-20 / permit
    bytes4 private constant SEL_TRANSFER = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 private constant SEL_TRANSFER_FROM = IERC20L.transferFrom.selector;
    bytes4 private constant SEL_APPROVE = IERC20L.approve.selector;
    bytes4 private constant SEL_INCREASE_ALLOWANCE = bytes4(keccak256("increaseAllowance(address,uint256)"));
    bytes4 private constant SEL_DECREASE_ALLOWANCE = bytes4(keccak256("decreaseAllowance(address,uint256)"));
    bytes4 private constant SEL_PERMIT = bytes4(keccak256("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)"));

    // Filecoin Pay
    bytes4 private constant SEL_DEPOSIT = bytes4(keccak256("deposit(address,address,uint256)"));
    bytes4 private constant SEL_DEPOSIT_PERMIT = bytes4(keccak256("depositWithPermit(address,address,uint256,uint256,uint8,bytes32,bytes32)"));
    bytes4 private constant SEL_DEPOSIT_PERMIT_OP = bytes4(keccak256("depositWithPermitAndApproveOperator(address,address,uint256,uint256,uint8,bytes32,bytes32,address,bool,uint256,uint256,uint256)"));
    bytes4 private constant SEL_WITHDRAW = bytes4(keccak256("withdraw(address,uint256)"));
    bytes4 private constant SEL_WITHDRAW_TO = IFilecoinPayL.withdrawTo.selector;
    bytes4 private constant SEL_SET_OP = IFilecoinPayL.setOperatorApproval.selector;
    bytes4 private constant SEL_INC_OP = bytes4(keccak256("increaseOperatorApproval(address,address,uint256,uint256)"));

    LockedSignerAccountBeaconFactory public immutable FACTORY;

    address public owner;
    bytes32 public passkeyX;
    bytes32 public passkeyY;
    uint256 public nonce;
    uint256 public sessionExpiry;
    mapping(address => uint256) public sessionSigners;
    bool public unassigned;
    bool private _initialized;

    constructor(address factory_) {
        FACTORY = LockedSignerAccountBeaconFactory(factory_);
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
        if (owner_ != address(0)) ISessionKeyRegistryL(FACTORY.SKR()).login(owner_, sessionExpiry_, _fwssScopes(), "fifolders");
    }

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

    /// @notice Session-key policy: any contract except the token and Filecoin Pay, no fund-moving selectors, not self session-key admin.
    function isSessionAllowed(address target, bytes4 selector) public view returns (bool) {
        if (target == address(this) || target == FACTORY.TOKEN() || target == FACTORY.PAY()) return false;
        if (_isFundSelector(selector)) return false;
        return true;
    }

    /// @notice Owner policy: value moves only to the Pay/FWSS allowlist (token only when spender/recipient is Pay or FWSS). No withdrawals.
    function isOwnerAllowed(address target, uint256 value, bytes calldata data) public view returns (bool) {
        if (data.length < 4) return false;
        bytes4 selector = bytes4(data);
        if (target == address(this)) {
            return value == 0 && (selector == this.addSessionKey.selector || selector == this.removeSessionKey.selector);
        }
        if (value != 0 && target != FACTORY.PAY() && target != FACTORY.FWSS()) return false;
        if (selector == SEL_WITHDRAW || selector == SEL_WITHDRAW_TO) return false;
        if (target == FACTORY.TOKEN()) return _ownerTokenOk(selector, data);
        if (target == FACTORY.PAY()) return _ownerPayOk(selector, data);
        if (target == FACTORY.FWSS()) return true;
        return value == 0 && !_isFundSelector(selector);
    }

    /// @notice Backward-compatible view: true if a session key may make this call (used by the sponsor pre-check for gasless ops).
    function isAllowed(address target, bytes4 selector) public view returns (bool) {
        return isSessionAllowed(target, selector);
    }

    function _isFundSelector(bytes4 selector) private pure returns (bool) {
        return selector == SEL_TRANSFER || selector == SEL_TRANSFER_FROM || selector == SEL_APPROVE
            || selector == SEL_INCREASE_ALLOWANCE || selector == SEL_DECREASE_ALLOWANCE || selector == SEL_PERMIT
            || selector == SEL_DEPOSIT || selector == SEL_DEPOSIT_PERMIT || selector == SEL_DEPOSIT_PERMIT_OP
            || selector == SEL_WITHDRAW || selector == SEL_WITHDRAW_TO || selector == SEL_SET_OP || selector == SEL_INC_OP;
    }

    function _allowlisted(address who) private view returns (bool) {
        return who == FACTORY.PAY() || who == FACTORY.FWSS();
    }

    function _ownerTokenOk(bytes4 selector, bytes calldata data) private view returns (bool) {
        if (selector == SEL_APPROVE || selector == SEL_INCREASE_ALLOWANCE || selector == SEL_DECREASE_ALLOWANCE) {
            if (data.length < 4 + 32) return false;
            return _allowlisted(address(uint160(uint256(bytes32(data[4:36])))));
        }
        if (selector == SEL_TRANSFER) {
            if (data.length < 4 + 32) return false;
            return _allowlisted(address(uint160(uint256(bytes32(data[4:36])))));
        }
        if (selector == SEL_TRANSFER_FROM) {
            if (data.length < 4 + 64) return false;
            return _allowlisted(address(uint160(uint256(bytes32(data[36:68])))));
        }
        if (selector == SEL_PERMIT) {
            // permit(owner, spender, ...)
            if (data.length < 4 + 64) return false;
            return _allowlisted(address(uint160(uint256(bytes32(data[36:68])))));
        }
        return false;
    }

    function _ownerPayOk(bytes4 selector, bytes calldata data) private view returns (bool) {
        if (selector == SEL_DEPOSIT || selector == SEL_DEPOSIT_PERMIT || selector == SEL_DEPOSIT_PERMIT_OP) {
            // deposit(token, to, amount, ...) — credit only this account
            if (data.length < 4 + 64) return false;
            return address(uint160(uint256(bytes32(data[36:68])))) == address(this);
        }
        if (selector == SEL_SET_OP || selector == SEL_INC_OP) {
            // setOperatorApproval(token, operator, ...) / increaseOperatorApproval(token, operator, ...)
            if (data.length < 4 + 64) return false;
            return address(uint160(uint256(bytes32(data[36:68])))) == FACTORY.FWSS();
        }
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
        if (data.length < 4) revert CallNotAllowed(target, bytes4(0));
        bytes4 selector = bytes4(data);
        bytes32 digest = executeDigest(target, value, data, nonce_, deadline);
        bool ownerSigned;
        if (signature.length == 65) {
            address signer = LockedLib.recover(digest, signature);
            ownerSigned = signer == owner && signer != address(0);
            if (!ownerSigned && sessionSigners[signer] < block.timestamp) revert BadSigner(signer);
        } else {
            if (passkeyX == bytes32(0)) revert BadPasskeySignature();
            LockedWebAuthn.Assertion memory a = abi.decode(signature, (LockedWebAuthn.Assertion));
            if (!LockedWebAuthn.verify(digest, a, passkeyX, passkeyY)) revert BadPasskeySignature();
            ownerSigned = true;
        }
        if (ownerSigned) {
            if (!isOwnerAllowed(target, value, data)) revert CallNotAllowed(target, selector);
        } else {
            if (value != 0) revert ValueNotAllowed();
            if (!isSessionAllowed(target, selector)) revert CallNotAllowed(target, selector);
        }
        nonce = nonce_ + 1;
        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) revert CallFailed(result);
        emit Executed(nonce_, target, selector, ownerSigned);
    }

    function _fwssScopes() private pure returns (bytes32[] memory perms) {
        perms = new bytes32[](3);
        perms[0] = ADD_PIECES;
        perms[1] = SCHEDULE_PIECE_REMOVALS;
        perms[2] = TERMINATE_SERVICE;
    }

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

/// @title LockedSignerAccountBeaconFactory
/// @notice Deploys BeaconProxy accounts. The beacon owner (initially the sponsor admin) can upgrade every account's
///         implementation; transfer it to a key-holding 0x address (for example Andy's Ledger) with Ownable.transferOwnership.
///         Factory admin (sponsor) still runs the warm pool, assign, and sweep. The f1 recovery masked-ID cannot own
///         the beacon: it cannot sign EVM upgrade transactions.
contract LockedSignerAccountBeaconFactory {
    error NotAdmin();
    error NoOwner();
    error NotAccount(address account);
    error CreateFailed();

    event AccountCreated(address indexed account, address indexed owner, bytes32 passkeyX, uint256 salt);
    event AccountAssigned(address indexed account, address indexed owner, bytes32 passkeyX, uint256 topUp);

    UpgradeableBeacon public immutable beacon;
    address public immutable IMPLEMENTATION;
    address public immutable FWSS;
    address public immutable PAY;
    address public immutable SKR;
    address public immutable TOKEN;
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
        IMPLEMENTATION = address(new LockedSignerAccountV2(address(this)));
        // Beacon owner is the sponsor (admin) until recover.ts --hand-beacon <0x> transfers it to a Ledger EOA.
        beacon = new UpgradeableBeacon(IMPLEMENTATION, admin_);
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

    function implementation() public view returns (address) {
        return beacon.implementation();
    }

    function _salt(address owner_, bytes32 qx, bytes32 qy, uint256 salt, uint256 sessionExpiry) private pure returns (bytes32) {
        return keccak256(abi.encode(owner_, qx, qy, salt, sessionExpiry));
    }

    function _init(address owner_, bytes32 qx, bytes32 qy, uint256 sessionExpiry) private pure returns (bytes memory) {
        return abi.encodeCall(LockedSignerAccountV2.initialize, (owner_, qx, qy, sessionExpiry));
    }

    function _proxyCode(bytes memory init) private view returns (bytes memory) {
        return abi.encodePacked(type(BeaconProxy).creationCode, abi.encode(address(beacon), init));
    }

    function predict(address owner_, bytes32 qx, bytes32 qy, uint256 salt, uint256 sessionExpiry) public view returns (address) {
        bytes memory code = _proxyCode(_init(owner_, qx, qy, sessionExpiry));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(owner_, qx, qy, salt, sessionExpiry), keccak256(code))))));
    }

    function _deploy(address owner_, bytes32 qx, bytes32 qy, uint256 salt, uint256 sessionExpiry)
        private
        returns (LockedSignerAccountV2 account)
    {
        bytes32 key = _salt(owner_, qx, qy, salt, sessionExpiry);
        bytes memory code = _proxyCode(_init(owner_, qx, qy, sessionExpiry));
        address instance;
        assembly {
            instance := create2(0, add(code, 0x20), mload(code), key)
        }
        if (instance == address(0)) revert CreateFailed();
        account = LockedSignerAccountV2(payable(instance));
        isAccount[instance] = true;
    }

    function create(address owner_, bytes32 qx, bytes32 qy, uint256 salt, uint256 sessionExpiry)
        external
        returns (LockedSignerAccountV2 account)
    {
        if (owner_ == address(0) && qx == bytes32(0)) revert NoOwner();
        address predicted = predict(owner_, qx, qy, salt, sessionExpiry);
        if (predicted.code.length > 0) return LockedSignerAccountV2(payable(predicted));
        account = _deploy(owner_, qx, qy, salt, sessionExpiry);
        emit AccountCreated(address(account), owner_, qx, salt);
    }

    function createPooled(uint256 salt, uint256 sessionExpiry) external onlyAdmin returns (LockedSignerAccountV2 account) {
        account = _deploy(address(0), bytes32(0), bytes32(0), salt, sessionExpiry);
        emit AccountCreated(address(account), address(0), bytes32(0), salt);
    }

    function assign(LockedSignerAccountV2 account, address owner_, bytes32 qx, bytes32 qy, uint256 topUp) external onlyAdmin {
        if (!isAccount[address(account)]) revert NotAccount(address(account));
        account.assignOwner(owner_, qx, qy);
        if (topUp > 0) {
            require(IERC20L(TOKEN).transferFrom(msg.sender, address(this), topUp), "transferFrom");
            IERC20L(TOKEN).approve(PAY, topUp);
            IFilecoinPayDepositL(PAY).deposit(TOKEN, address(account), topUp);
        }
        emit AccountAssigned(address(account), owner_, qx, topUp);
    }
}
