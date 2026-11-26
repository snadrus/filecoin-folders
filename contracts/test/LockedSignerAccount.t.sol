// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {LockedSignerAccount, LockedSignerAccountFactory} from "../src/LockedSignerAccount.sol";

contract LPay {
    mapping(address => uint256) public bal; // per-owner funds
    address public opOwner; address public op; uint256 public settled;
    function setOperatorApproval(address, address o, bool, uint256, uint256, uint256) external { opOwner = msg.sender; op = o; }
    function increaseOperatorApproval(address, address, uint256, uint256) external {}
    function credit(address who, uint256 a) external { bal[who] += a; }
    function withdraw(address, uint256 a) external { bal[msg.sender] -= a; }
    function withdrawTo(address, address to, uint256 a) external { bal[msg.sender] -= a; bal[to] += a; }
    function settleRail(uint256, uint256) external { settled++; }
    function terminateRail(uint256) external {}
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
    function terminateService(uint256, bytes calldata) external { terminated++; }
    function topUpCDNPaymentRails(uint256, uint256, uint256) external {}
    function setDataSetAuthorizer(uint256, address) external {}
}
contract LApp { uint256 public n; function commitFor(address) external { n++; } function other() external {} }

contract LockedSignerAccountTest is Test {
    LPay pay; LToken tok; LSKR skr; LFWSS fwss; LApp app; LockedSignerAccountFactory f; LockedSignerAccount acct;
    uint256 userPk = 0xA11CE; address user; address admin = address(0xAD); address treasury = address(0x7EA);
    uint256 constant EXP = 2_000_000_000;

    function setUp() public {
        user = vm.addr(userPk);
        pay = new LPay(); tok = new LToken(); skr = new LSKR(); app = new LApp();
        fwss = new LFWSS(address(pay), address(skr), address(tok), address(new LReg()));
        f = new LockedSignerAccountFactory(address(fwss), admin, treasury);
        acct = f.create(user, 0, EXP);
        pay.credit(address(acct), 100);
        assertEq(address(acct), f.predict(user, 0, EXP));
    }

    function _exec(address target, bytes memory data) internal returns (bytes memory) {
        return _execV(target, 0, data);
    }
    function _execV(address target, uint256 value, bytes memory data) internal returns (bytes memory) {
        uint256 n = acct.nonce(); uint256 dl = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, acct.executeDigest(target, value, data, n, dl));
        vm.prank(address(0xBEEF));
        return acct.execute(target, value, data, n, dl, abi.encodePacked(r, s, v));
    }
    function _expectBlocked(address target, bytes memory data) internal {
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.CallNotAllowed.selector, target, bytes4(data)));
        this.callExec(target, data);
    }
    function callExec(address target, bytes memory data) external { _exec(target, data); }

    function test_initScopes() public view {
        assertEq(pay.opOwner(), address(acct)); assertEq(pay.op(), address(fwss));
        assertEq(skr.authorizationExpiry(address(acct), user, acct.ADD_PIECES()), EXP);
        assertEq(skr.authorizationExpiry(address(acct), user, acct.SCHEDULE_PIECE_REMOVALS()), EXP);
        assertEq(skr.authorizationExpiry(address(acct), user, acct.TERMINATE_SERVICE()), EXP);
        assertEq(skr.authorizationExpiry(address(acct), user, acct.CREATE_DATA_SET()), 0, "user cannot sign CreateDataSet");
    }

    // ---- extraction attempts: all blocked
    function test_blockWithdraw() public { _expectBlocked(address(pay), abi.encodeCall(LPay.withdraw, (address(tok), 1))); }
    function test_blockWithdrawTo() public { _expectBlocked(address(pay), abi.encodeCall(LPay.withdrawTo, (address(tok), user, 1))); }
    function test_blockOperatorChanges() public {
        _expectBlocked(address(pay), abi.encodeCall(LPay.setOperatorApproval, (address(tok), user, true, 1, 1, 1)));
        _expectBlocked(address(pay), abi.encodeCall(LPay.increaseOperatorApproval, (address(tok), address(fwss), 1, 1)));
        _expectBlocked(address(pay), abi.encodeCall(LPay.terminateRail, (1)));
    }
    function test_blockTokenCalls() public {
        _expectBlocked(address(tok), abi.encodeCall(LToken.transfer, (user, 1)));
        _expectBlocked(address(tok), abi.encodeCall(LToken.approve, (user, 1)));
        _expectBlocked(address(tok), abi.encodeCall(LToken.transferFrom, (address(acct), user, 1)));
    }
    function test_blockNewSessionKeys() public {
        bytes32[] memory p = new bytes32[](1); p[0] = acct.CREATE_DATA_SET();
        _expectBlocked(address(skr), abi.encodeCall(LSKR.login, (user, EXP, p, "x")));
    }
    function test_blockOtherFwssCalls() public {
        _expectBlocked(address(fwss), abi.encodeCall(LFWSS.topUpCDNPaymentRails, (1, 1, 1)));
        _expectBlocked(address(fwss), abi.encodeCall(LFWSS.setDataSetAuthorizer, (1, user)));
    }
    function test_blockArbitraryContract() public { _expectBlocked(address(app), abi.encodeCall(LApp.other, ())); }
    function test_blockValue() public {
        vm.deal(address(acct), 1 ether);
        vm.expectRevert(LockedSignerAccount.ValueNotAllowed.selector);
        this.callExecV(address(app), 1, abi.encodeCall(LApp.other, ()));
    }
    function callExecV(address t, uint256 v, bytes memory d) external { _execV(t, v, d); }
    function test_blockSweepByUserAndRelayer() public {
        vm.prank(user); vm.expectRevert(LockedSignerAccount.NotAdmin.selector); acct.sweep(1);
        _expectBlocked(address(acct), abi.encodeCall(LockedSignerAccount.sweep, (1)));
    }
    function test_allowDataSetAdminOnly() public {
        string[] memory k = new string[](0);
        vm.prank(user); vm.expectRevert(LockedSignerAccount.NotAdmin.selector); acct.allowDataSet(2, 1, k, k);
        _expectBlocked(address(acct), abi.encodeCall(LockedSignerAccount.allowDataSet, (2, 1, k, k)));
    }
    function test_allowDataSetRejectsUnapprovedProvider() public {
        string[] memory k = new string[](0);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.ProviderNotApproved.selector, 9));
        acct.allowDataSet(9, 1, k, k);
    }
    function test_adminCannotAllowlistCoreContracts() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountFactory.ProtectedTarget.selector, address(pay)));
        f.setAppAllowed(address(pay), LPay.withdrawTo.selector, true);
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountFactory.ProtectedTarget.selector, address(tok)));
        f.setAppAllowed(address(tok), LToken.transfer.selector, true);
        vm.stopPrank();
    }

    // ---- allowed storage operations
    function test_allowedOps() public {
        _exec(address(pay), abi.encodeCall(LPay.settleRail, (1, 2))); assertEq(pay.settled(), 1);
        _exec(address(fwss), abi.encodeCall(LFWSS.terminateService, (1, ""))); assertEq(fwss.terminated(), 1);
        bytes32[] memory p = new bytes32[](1); p[0] = acct.ADD_PIECES();
        _exec(address(skr), abi.encodeCall(LSKR.revoke, (user, p, "x")));
        assertEq(skr.authorizationExpiry(address(acct), user, acct.ADD_PIECES()), 0);
        vm.prank(admin); f.setAppAllowed(address(app), LApp.commitFor.selector, true);
        _exec(address(app), abi.encodeCall(LApp.commitFor, (user))); assertEq(app.n(), 1);
    }
    function test_allowDataSetPinsApprovedPayee() public {
        string[] memory k = new string[](1); k[0] = "app"; string[] memory v = new string[](1); v[0] = "x";
        vm.prank(admin);
        address signer = acct.allowDataSet(2, 42, k, v);
        assertEq(signer, acct.createDataSetSigner(42, address(0x5002), k, v));
        assertEq(skr.authorizationExpiry(address(acct), signer, acct.CREATE_DATA_SET()), EXP);
        // a different payee or id derives a different (unauthorized) signer
        assertTrue(acct.createDataSetSigner(42, address(0x5009), k, v) != signer);
        assertTrue(acct.createDataSetSigner(43, address(0x5002), k, v) != signer);
    }
    // ---- browser session keys
    uint256 sessPk = 0x5E55;
    function _execAs(uint256 pk, address target, bytes memory data) internal returns (bytes memory) {
        uint256 n = acct.nonce(); uint256 dl = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, acct.executeDigest(target, 0, data, n, dl));
        return acct.execute(target, 0, data, n, dl, abi.encodePacked(r, s, v));
    }
    function execAs(uint256 pk, address target, bytes memory data) external { _execAs(pk, target, data); }
    function test_sessionKeyLifecycle() public {
        address sess = vm.addr(sessPk);
        vm.prank(admin); f.setAppAllowed(address(app), LApp.commitFor.selector, true);
        // unknown key cannot execute
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.BadSigner.selector, sess));
        this.execAs(sessPk, address(app), abi.encodeCall(LApp.commitFor, (user)));
        // owner adds it (expiry capped at account sessionExpiry)
        _exec(address(acct), abi.encodeCall(LockedSignerAccount.addSessionKey, (sess, EXP + 1)));
        assertEq(acct.sessionSigners(sess), EXP);
        assertEq(skr.authorizationExpiry(address(acct), sess, acct.ADD_PIECES()), EXP);
        assertEq(skr.authorizationExpiry(address(acct), sess, acct.CREATE_DATA_SET()), 0);
        _execAs(sessPk, address(app), abi.encodeCall(LApp.commitFor, (user))); assertEq(app.n(), 1);
        // session key cannot add keys or reach blocked targets
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.BadSigner.selector, sess));
        this.execAs(sessPk, address(acct), abi.encodeCall(LockedSignerAccount.addSessionKey, (address(0x1), EXP)));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.CallNotAllowed.selector, address(pay), LPay.withdrawTo.selector));
        this.execAs(sessPk, address(pay), abi.encodeCall(LPay.withdrawTo, (address(tok), sess, 1)));
        // direct calls are rejected
        vm.expectRevert(LockedSignerAccount.NotSelf.selector); acct.addSessionKey(sess, EXP);
        // owner removes it
        _exec(address(acct), abi.encodeCall(LockedSignerAccount.removeSessionKey, (sess)));
        assertEq(acct.sessionSigners(sess), 0);
        assertEq(skr.authorizationExpiry(address(acct), sess, acct.ADD_PIECES()), 0);
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccount.BadSigner.selector, sess));
        this.execAs(sessPk, address(app), abi.encodeCall(LApp.commitFor, (user)));
    }
    function test_sweepOnlyToTreasury() public {
        vm.prank(admin); acct.sweep(60);
        assertEq(pay.bal(treasury), 60); assertEq(pay.bal(address(acct)), 40);
    }
    function test_userRawKeyHasNoPayerFunds() public {
        // Even with gas, the user's own key is not the payer: withdrawing as itself touches an empty account.
        vm.prank(user); vm.expectRevert(); pay.withdraw(address(tok), 1);
        assertEq(pay.bal(address(acct)), 100);
    }
}
