// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {LockedSignerAccount, LockedSignerAccountFactory, LockedWebAuthn} from "../src/LockedSignerAccount.sol";

contract LPay {
    mapping(address => uint256) public bal;
    address public opOwner; address public op; uint256 public settled;
    function setOperatorApproval(address, address o, bool, uint256, uint256, uint256) external { opOwner = msg.sender; op = o; }
    function increaseOperatorApproval(address, address, uint256, uint256) external {}
    function credit(address who, uint256 a) external { bal[who] += a; }
    function withdraw(address, uint256 a) external { bal[msg.sender] -= a; }
    function withdrawTo(address, address to, uint256 a) external { bal[msg.sender] -= a; bal[to] += a; }
    function settleRail(uint256, uint256) external { settled++; }
    function terminateRail(uint256) external {}
    function deposit(address, address to, uint256 a) external payable { bal[to] += a; }
}
contract LToken {
    function transfer(address, uint256) external pure returns (bool) { return true; }
    function approve(address, uint256) external pure returns (bool) { return true; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return true; }
}
contract LSKR {
    mapping(address => mapping(address => mapping(bytes32 => uint256))) public authorizationExpiry;
    function login(address s, uint256 e, bytes32[] calldata p, string calldata) external { for (uint256 i; i < p.length; i++) authorizationExpiry[msg.sender][s][p[i]] = e; }
    function revoke(address s, bytes32[] calldata p, string calldata) external { for (uint256 i; i < p.length; i++) authorizationExpiry[msg.sender][s][p[i]] = 0; }
}
contract LReg { function getProviderPayee(uint256 id) external pure returns (address) { return address(uint160(0x5000 + id)); } }
contract LFWSS {
    address public paymentsContractAddress; address public sessionKeyRegistry; address public usdfcTokenAddress; address public serviceProviderRegistry;
    uint256 public terminated;
    constructor(address p, address s, address u, address r) { paymentsContractAddress = p; sessionKeyRegistry = s; usdfcTokenAddress = u; serviceProviderRegistry = r; }
    function isProviderApproved(uint256 id) external pure returns (bool) { return id == 2; }
    function eip712Domain() external view returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory) {
        return (0x0f, "FilecoinWarmStorageService", "1", block.chainid, address(this), bytes32(0), new uint256[](0));
    }
    function terminateService(uint256) external { terminated++; }
    function terminateService(uint256, bytes calldata) external { terminated++; }
    function topUpCDNPaymentRails(uint256, uint256, uint256) external {}
    function setDataSetAuthorizer(uint256, address) external {}
}
contract LPDP { function deleteDataSet(uint256, bytes calldata) external {} function addPieces(uint256) external {} }
contract LRegistry {
    uint256 public n;
    function commit(bytes32, bytes32, bytes calldata, uint64) external { n++; }
    function setWriter(bytes32, address, bool) external {}
    function commitFor(address, bytes32, bytes32, bytes calldata, uint64) external {}
}

contract LockedSignerAccountTest is Test {
    LPay pay; LToken tok; LSKR skr; LFWSS fwss; LPDP pdp; LRegistry reg; LockedSignerAccountFactory f; LockedSignerAccount acct;
    uint256 userPk = 0xA11CE; address user; address admin = address(0xAD); address treasury = address(0x7EA);
    uint256 constant EXP = 2_000_000_000;
    uint256 sessPk = 0x5E55;

    function setUp() public {
        user = vm.addr(userPk);
        pay = new LPay(); tok = new LToken(); skr = new LSKR(); pdp = new LPDP(); reg = new LRegistry();
        fwss = new LFWSS(address(pay), address(skr), address(tok), address(new LReg()));
        f = new LockedSignerAccountFactory(address(fwss), address(reg), admin, treasury);
        acct = f.create(user, 0, 0, 0, EXP);
        pay.credit(address(acct), 100);
        assertEq(address(acct), f.predict(user, 0, 0, 0, EXP));
        assertTrue(f.isAccount(address(acct)));
    }

    function _sig(uint256 pk, address target, bytes memory data) internal view returns (uint256 n, uint256 dl, bytes memory sig) {
        n = acct.nonce(); dl = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, acct.executeDigest(target, 0, data, n, dl));
        sig = abi.encodePacked(r, s, v);
    }
    function _execAs(uint256 pk, address target, bytes memory data) internal returns (bytes memory) {
        (uint256 n, uint256 dl, bytes memory sig) = _sig(pk, target, data);
        vm.prank(address(0xBEEF));
        return acct.execute(target, 0, data, n, dl, sig);
    }
    function execAs(uint256 pk, address target, bytes memory data) external { _execAs(pk, target, data); }
    function _exec(address target, bytes memory data) internal returns (bytes memory) { return _execAs(userPk, target, data); }
    function _expectBlocked(address target, bytes memory data) internal {
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.CallNotAllowed.selector, target, bytes4(data)));
        this.execAs(userPk, target, data);
    }

    function test_initScopes() public view {
        assertEq(pay.opOwner(), address(acct)); assertEq(pay.op(), address(fwss));
        assertEq(skr.authorizationExpiry(address(acct), user, acct.ADD_PIECES()), EXP);
        assertEq(skr.authorizationExpiry(address(acct), user, acct.CREATE_DATA_SET()), 0, "user cannot sign CreateDataSet");
    }
    function test_cannotReinitialize() public {
        vm.expectRevert(LockedSignerAccount.NotFactory.selector); acct.initialize(user, 0, 0, EXP);
        vm.prank(address(f)); vm.expectRevert(LockedSignerAccount.AlreadyInitialized.selector); acct.initialize(user, 0, 0, EXP);
    }

    // ---- fixed policy: every call outside FWSS.terminateService / registry.commit / self session keys reverts
    function test_blockFilecoinPay() public {
        _expectBlocked(address(pay), abi.encodeCall(LPay.withdraw, (address(tok), 1)));
        _expectBlocked(address(pay), abi.encodeCall(LPay.withdrawTo, (address(tok), user, 1)));
        _expectBlocked(address(pay), abi.encodeCall(LPay.setOperatorApproval, (address(tok), user, true, 1, 1, 1)));
        _expectBlocked(address(pay), abi.encodeCall(LPay.increaseOperatorApproval, (address(tok), address(fwss), 1, 1)));
        _expectBlocked(address(pay), abi.encodeCall(LPay.settleRail, (1, 1)));
        _expectBlocked(address(pay), abi.encodeCall(LPay.terminateRail, (1)));
    }
    function test_blockToken() public {
        _expectBlocked(address(tok), abi.encodeCall(LToken.transfer, (user, 1)));
        _expectBlocked(address(tok), abi.encodeCall(LToken.approve, (user, 1)));
        _expectBlocked(address(tok), abi.encodeCall(LToken.transferFrom, (address(acct), user, 1)));
    }
    function test_blockSessionKeyRegistry() public {
        bytes32[] memory p = new bytes32[](1); p[0] = acct.CREATE_DATA_SET();
        _expectBlocked(address(skr), abi.encodeCall(LSKR.login, (user, EXP, p, "x")));
        _expectBlocked(address(skr), abi.encodeCall(LSKR.revoke, (user, p, "x")));
    }
    function test_blockOtherFwssAndPdp() public {
        _expectBlocked(address(fwss), abi.encodeCall(LFWSS.topUpCDNPaymentRails, (1, 1, 1)));
        _expectBlocked(address(fwss), abi.encodeCall(LFWSS.setDataSetAuthorizer, (1, user)));
        _expectBlocked(address(fwss), abi.encodeWithSignature("terminateService(uint256,bytes)", 1, ""));
        _expectBlocked(address(pdp), abi.encodeCall(LPDP.deleteDataSet, (1, "")));
        _expectBlocked(address(pdp), abi.encodeCall(LPDP.addPieces, (1)));
    }
    function test_blockRegistryExceptCommit() public {
        _expectBlocked(address(reg), abi.encodeCall(LRegistry.setWriter, (bytes32(0), user, true)));
        _expectBlocked(address(reg), abi.encodeCall(LRegistry.commitFor, (user, bytes32(0), bytes32(0), "", 0)));
    }
    function test_blockSelfAdminPaths() public {
        string[] memory k = new string[](0);
        _expectBlocked(address(acct), abi.encodeCall(LockedSignerAccount.sweep, (1)));
        _expectBlocked(address(acct), abi.encodeCall(LockedSignerAccount.allowDataSet, (2, 1, k, k)));
        _expectBlocked(address(f), abi.encodeCall(LockedSignerAccountFactory.setTreasury, (user)));
    }
    function test_blockValue() public {
        vm.deal(address(acct), 1 ether);
        bytes memory d = abi.encodeWithSignature("terminateService(uint256)", uint256(1));
        vm.expectRevert(LockedSignerAccount.ValueNotAllowed.selector);
        acct.execute(address(fwss), 1, d, 0, block.timestamp + 1, new bytes(65));
    }
    /// Fuzz: any target other than the three allowed ones reverts, whatever the selector.
    function testFuzz_onlyPolicyTargets(address target, bytes4 selector) public view {
        bool allowed = acct.isAllowed(target, selector);
        if (allowed) {
            assertTrue(
                (target == address(fwss) && selector == acct.TERMINATE_SERVICE_SELECTOR())
                    || (target == address(reg) && selector == acct.REGISTRY_COMMIT_SELECTOR())
                    || (target == address(acct) && (selector == LockedSignerAccount.addSessionKey.selector || selector == LockedSignerAccount.removeSessionKey.selector))
            );
        }
    }
    /// The admin has no function that widens the policy; the factory exposes only admin/treasury rotation.
    function test_adminCannotWidenPolicy() public {
        vm.startPrank(admin);
        (bool ok,) = address(f).call(abi.encodeWithSignature("setAppAllowed(address,bytes4,bool)", address(pay), LPay.withdrawTo.selector, true));
        assertFalse(ok);
        f.setTreasury(admin); f.setAdmin(address(0xA2));
        vm.stopPrank();
        assertFalse(acct.isAllowed(address(pay), LPay.withdrawTo.selector));
        assertFalse(acct.isAllowed(address(tok), LToken.transfer.selector));
    }
    function test_registryDisabledWhenZero() public {
        LockedSignerAccountFactory f2 = new LockedSignerAccountFactory(address(fwss), address(0), admin, treasury);
        LockedSignerAccount a2 = f2.create(user, 0, 0, 0, EXP);
        assertFalse(a2.isAllowed(address(reg), acct.REGISTRY_COMMIT_SELECTOR()));
        assertFalse(a2.isAllowed(address(0), acct.REGISTRY_COMMIT_SELECTOR()));
    }

    // ---- allowed operations
    function test_allowedOps() public {
        _exec(address(fwss), abi.encodeWithSignature("terminateService(uint256)", uint256(1))); assertEq(fwss.terminated(), 1);
        _exec(address(reg), abi.encodeCall(LRegistry.commit, (bytes32(0), bytes32(0), "x", 0))); assertEq(reg.n(), 1);
    }
    function test_allowDataSetAdminOnly() public {
        string[] memory k = new string[](0);
        vm.prank(user); vm.expectRevert(LockedSignerAccount.NotAdmin.selector); acct.allowDataSet(2, 1, k, k);
        vm.prank(admin); vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.ProviderNotApproved.selector, 9)); acct.allowDataSet(9, 1, k, k);
    }
    function test_allowDataSetPinsApprovedPayee() public {
        string[] memory k = new string[](1); k[0] = "app"; string[] memory v = new string[](1); v[0] = "x";
        vm.prank(admin);
        address signer = acct.allowDataSet(2, 42, k, v);
        assertEq(signer, acct.createDataSetSigner(42, address(0x5002), k, v));
        assertEq(skr.authorizationExpiry(address(acct), signer, acct.CREATE_DATA_SET()), EXP);
        assertTrue(acct.createDataSetSigner(42, address(0x5009), k, v) != signer);
    }
    function test_sweepOnlyAdminToTreasury() public {
        vm.prank(user); vm.expectRevert(LockedSignerAccount.NotAdmin.selector); acct.sweep(1);
        vm.prank(admin); acct.sweep(60);
        assertEq(pay.bal(treasury), 60); assertEq(pay.bal(address(acct)), 40);
    }
    function test_userRawKeyHasNoPayerFunds() public {
        vm.prank(user); vm.expectRevert(); pay.withdraw(address(tok), 1);
        assertEq(pay.bal(address(acct)), 100);
    }
    function test_sessionKeyLifecycle() public {
        address sess = vm.addr(sessPk);
        bytes memory commit = abi.encodeCall(LRegistry.commit, (bytes32(0), bytes32(0), "x", 0));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.BadSigner.selector, sess));
        this.execAs(sessPk, address(reg), commit);
        _exec(address(acct), abi.encodeCall(LockedSignerAccount.addSessionKey, (sess, EXP + 1)));
        assertEq(acct.sessionSigners(sess), EXP);
        assertEq(skr.authorizationExpiry(address(acct), sess, acct.ADD_PIECES()), EXP);
        assertEq(skr.authorizationExpiry(address(acct), sess, acct.CREATE_DATA_SET()), 0);
        _execAs(sessPk, address(reg), commit); assertEq(reg.n(), 1);
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.BadSigner.selector, sess));
        this.execAs(sessPk, address(acct), abi.encodeCall(LockedSignerAccount.addSessionKey, (address(0x1), EXP)));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.CallNotAllowed.selector, address(pay), LPay.withdrawTo.selector));
        this.execAs(sessPk, address(pay), abi.encodeCall(LPay.withdrawTo, (address(tok), sess, 1)));
        vm.expectRevert(LockedSignerAccount.NotSelf.selector); acct.addSessionKey(sess, EXP);
        _exec(address(acct), abi.encodeCall(LockedSignerAccount.removeSessionKey, (sess)));
        assertEq(acct.sessionSigners(sess), 0);
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.BadSigner.selector, sess));
        this.execAs(sessPk, address(reg), commit);
    }

    // ---- passkey (WebAuthn P-256) owner
    uint256 constant PASSKEY_PK = 0x1234abcd;
    function _passkeyAccount() internal returns (LockedSignerAccount a) {
        (uint256 x, uint256 y) = vm.publicKeyP256(PASSKEY_PK);
        a = f.create(address(0), bytes32(x), bytes32(y), 0, EXP);
    }
    function _assertion(bytes32 challenge, uint256 pk) internal pure returns (bytes memory) {
        bytes memory authData = abi.encodePacked(sha256("localhost"), uint8(0x05), uint32(1));
        string memory json = string.concat('{"type":"webauthn.get","challenge":"', Base64.encodeURL(abi.encodePacked(challenge)), '","origin":"http://localhost"}');
        bytes32 h = sha256(abi.encodePacked(authData, sha256(bytes(json))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, h);
        return abi.encode(LockedWebAuthn.Assertion(authData, json, 23, 1, r, s));
    }
    function passkeyExec(LockedSignerAccount a, address target, bytes memory data, uint256 pk) external {
        uint256 n = a.nonce(); uint256 dl = block.timestamp + 60;
        a.execute(target, 0, data, n, dl, _assertion(a.executeDigest(target, 0, data, n, dl), pk));
    }
    function test_passkeyOwnerAddsSessionKey() public {
        LockedSignerAccount a = _passkeyAccount();
        assertEq(a.owner(), address(0));
        address sess = vm.addr(sessPk);
        this.passkeyExec(a, address(a), abi.encodeCall(LockedSignerAccount.addSessionKey, (sess, EXP)), PASSKEY_PK);
        assertEq(a.sessionSigners(sess), EXP);
        assertEq(skr.authorizationExpiry(address(a), sess, a.ADD_PIECES()), EXP);
        // the passkey is still bound by the fixed policy
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.CallNotAllowed.selector, address(pay), LPay.withdrawTo.selector));
        this.passkeyExec(a, address(pay), abi.encodeCall(LPay.withdrawTo, (address(tok), sess, 1)), PASSKEY_PK);
    }
    function test_passkeyRejectsWrongKeyAndReplay() public {
        LockedSignerAccount a = _passkeyAccount();
        bytes memory d = abi.encodeWithSignature("terminateService(uint256)", uint256(1));
        vm.expectRevert(LockedSignerAccount.BadPasskeySignature.selector);
        this.passkeyExec(a, address(fwss), d, PASSKEY_PK + 1);
        // a valid assertion for one digest cannot be replayed (nonce moves)
        uint256 dl = block.timestamp + 60;
        bytes memory sig = _assertion(a.executeDigest(address(fwss), 0, d, 0, dl), PASSKEY_PK);
        a.execute(address(fwss), 0, d, 0, dl, sig);
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.BadNonce.selector, 1, 0));
        a.execute(address(fwss), 0, d, 0, dl, sig);
        // an EOA signature cannot act as a passkey account owner
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, a.executeDigest(address(fwss), 0, d, 1, dl));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.BadSigner.selector, user));
        a.execute(address(fwss), 0, d, 1, dl, abi.encodePacked(r, s, v));
    }
    function test_factoryRequiresOwner() public {
        vm.expectRevert(LockedSignerAccountFactory.NoOwner.selector); f.create(address(0), 0, 0, 0, EXP);
    }

    // ---- warm pool: ownerless account, one-shot assignment
    function _pooled() internal returns (LockedSignerAccount p) {
        vm.prank(admin); p = f.createPooled(7, EXP);
        pay.credit(address(p), 1e18);
    }
    function test_poolCreateAdminOnly() public {
        vm.expectRevert(LockedSignerAccountFactory.NotAdmin.selector); f.createPooled(7, EXP);
        LockedSignerAccount p = _pooled();
        assertTrue(f.isAccount(address(p))); assertTrue(p.unassigned()); assertEq(p.owner(), address(0));
        assertEq(pay.opOwner(), address(p));
    }
    function test_poolUnassignedNobodyCanExecute() public {
        LockedSignerAccount p = _pooled();
        bytes memory d = abi.encodeWithSignature("terminateService(uint256)", uint256(1));
        uint256 dl = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(userPk, p.executeDigest(address(fwss), 0, d, 0, dl));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.BadSigner.selector, user));
        p.execute(address(fwss), 0, d, 0, dl, abi.encodePacked(r, s_, v));
        // ecrecover failure (address 0) must not match the zero owner
        vm.expectRevert();
        p.execute(address(fwss), 0, d, 0, dl, new bytes(65));
        vm.expectRevert(LockedSignerAccount.BadPasskeySignature.selector);
        p.execute(address(fwss), 0, d, 0, dl, new bytes(300));
    }
    function test_poolAssignOneShot() public {
        LockedSignerAccount p = _pooled();
        vm.expectRevert(LockedSignerAccountFactory.NotAdmin.selector); f.assign(p, user, 0, 0, 0);
        vm.prank(admin); vm.expectRevert(LockedSignerAccount.NotFactory.selector); p.assignOwner(admin, 0, 0);
        vm.prank(admin); vm.expectRevert(LockedSignerAccount.NoOwner.selector); f.assign(p, address(0), 0, 0, 0);
        vm.prank(admin); vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountFactory.NotAccount.selector, address(0x1234))); f.assign(LockedSignerAccount(address(0x1234)), user, 0, 0, 0);
        vm.prank(admin); f.assign(p, user, 0, 0, 5e17);
        assertEq(p.owner(), user); assertFalse(p.unassigned());
        assertEq(pay.bal(address(p)), 15e17, "top-up deposited in the same tx");
        assertEq(skr.authorizationExpiry(address(p), user, p.ADD_PIECES()), EXP);
        // never again: not to the admin, not to anyone
        vm.prank(admin); vm.expectRevert(LockedSignerAccount.NotUnassigned.selector); f.assign(p, admin, 0, 0, 0);
        vm.prank(address(f)); vm.expectRevert(LockedSignerAccount.NotUnassigned.selector); p.assignOwner(admin, 0, 0);
        // an owner-created account was never assignable
        vm.prank(admin); vm.expectRevert(LockedSignerAccount.NotUnassigned.selector); f.assign(acct, admin, 0, 0, 0);
    }
    function test_poolAssignedNoExtraction() public {
        LockedSignerAccount p = _pooled();
        vm.prank(admin); f.assign(p, user, 0, 0, 0);
        acct = p; // reuse the policy helpers on the assigned pool account
        _expectBlocked(address(pay), abi.encodeCall(LPay.withdraw, (address(tok), 1)));
        _expectBlocked(address(pay), abi.encodeCall(LPay.withdrawTo, (address(tok), user, 1)));
        _expectBlocked(address(pay), abi.encodeCall(LPay.setOperatorApproval, (address(tok), user, true, 1, 1, 1)));
        _expectBlocked(address(tok), abi.encodeCall(LToken.transfer, (user, 1)));
        _expectBlocked(address(tok), abi.encodeCall(LToken.approve, (user, 1)));
        _expectBlocked(address(p), abi.encodeCall(LockedSignerAccount.sweep, (1)));
        _expectBlocked(address(p), abi.encodeCall(LockedSignerAccount.assignOwner, (user, 0, 0)));
        _expectBlocked(address(f), abi.encodeCall(LockedSignerAccountFactory.assign, (p, user, 0, 0, 0)));
        _exec(address(fwss), abi.encodeWithSignature("terminateService(uint256)", uint256(1)));
        assertEq(fwss.terminated(), 1);
        vm.prank(user); vm.expectRevert(LockedSignerAccount.NotAdmin.selector); p.sweep(1);
        vm.prank(admin); p.sweep(1e17);
        assertEq(pay.bal(treasury), 1e17, "sweep only to treasury");
    }
    function test_poolAssignPasskey() public {
        LockedSignerAccount p = _pooled();
        (uint256 qxU, uint256 qyU) = vm.publicKeyP256(0xC0FFEE);
        vm.prank(admin); f.assign(p, address(0), bytes32(qxU), bytes32(qyU), 0);
        assertEq(p.passkeyX(), bytes32(qxU)); assertEq(p.owner(), address(0)); assertFalse(p.unassigned());
        vm.prank(admin); vm.expectRevert(LockedSignerAccount.NotUnassigned.selector); f.assign(p, admin, 0, 0, 0);
    }
}
