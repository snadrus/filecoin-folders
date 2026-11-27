// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {LockedSignerAccountV2, LockedSignerAccountBeaconFactory} from "../src/LockedSignerAccountV2.sol";
import {UpgradeableBeacon} from "../src/beacon/Beacon.sol";
import {NotOwner} from "../src/beacon/Beacon.sol";

contract LPay {
    mapping(address => uint256) public bal;
    address public opOwner; address public op;
    function setOperatorApproval(address, address o, bool, uint256, uint256, uint256) external { opOwner = msg.sender; op = o; }
    function increaseOperatorApproval(address, address, uint256, uint256) external {}
    function credit(address who, uint256 a) external { bal[who] += a; }
    function withdraw(address, uint256 a) external { bal[msg.sender] -= a; }
    function withdrawTo(address, address to, uint256 a) external { bal[msg.sender] -= a; bal[to] += a; }
    function settleRail(uint256, uint256) external {}
    function terminateRail(uint256) external {}
    function deposit(address, address to, uint256 a) external payable { bal[to] += a; }
}

contract LToken {
    event Transfer(address to, uint256 amount);
    event Approval(address spender, uint256 amount);
    function transfer(address to, uint256 amount) external returns (bool) { emit Transfer(to, amount); return true; }
    function approve(address spender, uint256 amount) external returns (bool) { emit Approval(spender, amount); return true; }
    function transferFrom(address, address to, uint256 amount) external returns (bool) { emit Transfer(to, amount); return true; }
    function increaseAllowance(address spender, uint256 amount) external returns (bool) { emit Approval(spender, amount); return true; }
    function permit(address, address spender, uint256, uint256, uint8, bytes32, bytes32) external { emit Approval(spender, 0); }
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
    function topUpCDNPaymentRails(uint256, uint256, uint256) external {}
}

contract LRegistry {
    uint256 public n;
    function commit(bytes32, bytes32, bytes calldata, uint64) external { n++; }
    function setWriter(bytes32, address, bool) external {}
}

contract LClub {
    uint256 public n;
    function join() external { n++; }
    function removeAdminWithSignatures(bytes calldata) external { n++; }
}

contract LockedSignerAccountV2Test is Test {
    LPay pay; LToken tok; LSKR skr; LFWSS fwss; LRegistry reg; LClub club;
    LockedSignerAccountBeaconFactory f; LockedSignerAccountV2 acct;
    uint256 userPk = 0xA11CE; address user; address admin = address(0xAD); address treasury = address(0x7EA);
    uint256 constant EXP = 2_000_000_000;
    uint256 sessPk = 0x5E55; address sess;

    function setUp() public {
        user = vm.addr(userPk);
        sess = vm.addr(sessPk);
        pay = new LPay(); tok = new LToken(); skr = new LSKR(); club = new LClub(); reg = new LRegistry();
        fwss = new LFWSS(address(pay), address(skr), address(tok), address(new LReg()));
        f = new LockedSignerAccountBeaconFactory(address(fwss), address(reg), admin, treasury);
        acct = f.create(user, 0, 0, 0, EXP);
        pay.credit(address(acct), 100);
        assertEq(address(acct), f.predict(user, 0, 0, 0, EXP));
        assertTrue(f.isAccount(address(acct)));
        assertEq(f.beacon().owner(), admin);
        assertEq(f.implementation(), f.IMPLEMENTATION());
    }

    function _sig(uint256 pk, address target, uint256 value, bytes memory data) internal view returns (uint256 n, uint256 dl, bytes memory sig) {
        n = acct.nonce(); dl = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, acct.executeDigest(target, value, data, n, dl));
        sig = abi.encodePacked(r, s, v);
    }

    function _execAs(uint256 pk, address target, bytes memory data) internal returns (bytes memory) {
        return _execAsVal(pk, target, 0, data);
    }

    function _execAsVal(uint256 pk, address target, uint256 value, bytes memory data) internal returns (bytes memory) {
        (uint256 n, uint256 dl, bytes memory sig) = _sig(pk, target, value, data);
        vm.prank(address(0xBEEF));
        return acct.execute(target, value, data, n, dl, sig);
    }

    function execAs(uint256 pk, address target, bytes memory data) external { _execAs(pk, target, data); }
    function execAsVal(uint256 pk, address target, uint256 value, bytes memory data) external { _execAsVal(pk, target, value, data); }

    function _addSession() internal {
        _execAs(userPk, address(acct), abi.encodeCall(LockedSignerAccountV2.addSessionKey, (sess, EXP)));
        assertEq(acct.sessionSigners(sess), EXP);
    }

    function test_initAndPredict() public view {
        assertEq(pay.opOwner(), address(acct));
        assertEq(pay.op(), address(fwss));
        assertEq(skr.authorizationExpiry(address(acct), user, acct.ADD_PIECES()), EXP);
    }

    function test_cannotReinitialize() public {
        vm.expectRevert(LockedSignerAccountV2.NotFactory.selector);
        acct.initialize(user, 0, 0, EXP);
        vm.prank(address(f));
        vm.expectRevert(LockedSignerAccountV2.AlreadyInitialized.selector);
        acct.initialize(user, 0, 0, EXP);
    }

    // ---- session key: any non-fund contract, including registry, FWSS terminate, FiClub
    function test_sessionCanCallAnyNonFundContract() public {
        _addSession();
        _execAs(sessPk, address(reg), abi.encodeCall(LRegistry.commit, (bytes32(0), bytes32(0), "x", 0)));
        assertEq(reg.n(), 1);
        _execAs(sessPk, address(fwss), abi.encodeWithSignature("terminateService(uint256)", uint256(1)));
        assertEq(fwss.terminated(), 1);
        _execAs(sessPk, address(club), abi.encodeCall(LClub.join, ()));
        _execAs(sessPk, address(club), abi.encodeCall(LClub.removeAdminWithSignatures, (hex"01")));
        assertEq(club.n(), 2);
        _execAs(sessPk, address(reg), abi.encodeCall(LRegistry.setWriter, (bytes32(0), user, true))); // no funds, any selector ok
    }

    function test_sessionBlockedFromTokenAndPayAndFundSelectors() public {
        _addSession();
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(tok), LToken.transfer.selector));
        this.execAs(sessPk, address(tok), abi.encodeCall(LToken.transfer, (user, 1)));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(tok), LToken.approve.selector));
        this.execAs(sessPk, address(tok), abi.encodeCall(LToken.approve, (user, 1)));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(tok), LToken.transferFrom.selector));
        this.execAs(sessPk, address(tok), abi.encodeCall(LToken.transferFrom, (address(acct), user, 1)));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(tok), LToken.increaseAllowance.selector));
        this.execAs(sessPk, address(tok), abi.encodeCall(LToken.increaseAllowance, (user, 1)));
        bytes memory permit = abi.encodeWithSignature("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", user, user, 1, 1, uint8(0), bytes32(0), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(tok), bytes4(permit)));
        this.execAs(sessPk, address(tok), permit);
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(pay), LPay.deposit.selector));
        this.execAs(sessPk, address(pay), abi.encodeCall(LPay.deposit, (address(tok), address(acct), 1)));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(pay), LPay.withdrawTo.selector));
        this.execAs(sessPk, address(pay), abi.encodeCall(LPay.withdrawTo, (address(tok), user, 1)));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(pay), LPay.setOperatorApproval.selector));
        this.execAs(sessPk, address(pay), abi.encodeCall(LPay.setOperatorApproval, (address(tok), address(fwss), true, 1, 1, 1)));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(acct), LockedSignerAccountV2.addSessionKey.selector));
        this.execAs(sessPk, address(acct), abi.encodeCall(LockedSignerAccountV2.addSessionKey, (sess, EXP)));
    }

    function test_sessionCannotSendValue() public {
        _addSession();
        vm.deal(address(acct), 1 ether);
        vm.expectRevert(LockedSignerAccountV2.ValueNotAllowed.selector);
        this.execAsVal(sessPk, address(club), 1, abi.encodeCall(LClub.join, ()));
    }

    // ---- owner value moves: only allowlist, never to the user, no withdraw
    function test_ownerCanApproveAndDepositToSelfAndSetFwssOperator() public {
        _execAs(userPk, address(tok), abi.encodeCall(LToken.approve, (address(pay), 5)));
        _execAs(userPk, address(tok), abi.encodeCall(LToken.increaseAllowance, (address(fwss), 5)));
        _execAs(userPk, address(pay), abi.encodeCall(LPay.deposit, (address(tok), address(acct), 1)));
        assertEq(pay.bal(address(acct)), 101);
        _execAs(userPk, address(pay), abi.encodeCall(LPay.setOperatorApproval, (address(tok), address(fwss), true, 1, 1, 1)));
        assertEq(pay.op(), address(fwss));
        _execAs(userPk, address(fwss), abi.encodeCall(LFWSS.topUpCDNPaymentRails, (1, 1, 1)));
        _execAs(userPk, address(tok), abi.encodeCall(LToken.transfer, (address(pay), 1)));
    }

    function test_ownerCannotSendFundsToUserOrWithdraw() public {
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(tok), LToken.transfer.selector));
        this.execAs(userPk, address(tok), abi.encodeCall(LToken.transfer, (user, 1)));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(tok), LToken.approve.selector));
        this.execAs(userPk, address(tok), abi.encodeCall(LToken.approve, (user, 1)));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(pay), LPay.deposit.selector));
        this.execAs(userPk, address(pay), abi.encodeCall(LPay.deposit, (address(tok), user, 1)));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(pay), LPay.withdrawTo.selector));
        this.execAs(userPk, address(pay), abi.encodeCall(LPay.withdrawTo, (address(tok), user, 1)));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(pay), LPay.withdraw.selector));
        this.execAs(userPk, address(pay), abi.encodeCall(LPay.withdraw, (address(tok), 1)));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, address(pay), LPay.setOperatorApproval.selector));
        this.execAs(userPk, address(pay), abi.encodeCall(LPay.setOperatorApproval, (address(tok), user, true, 1, 1, 1)));
    }

    function test_ownerValueOnlyToAllowlist() public {
        vm.deal(address(acct), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV2.CallNotAllowed.selector, user, bytes4(0)));
        this.execAsVal(userPk, user, 1, hex"00");
        // payable deposit to Pay, credited to this account, is allowed
        _execAsVal(userPk, address(pay), 1, abi.encodeCall(LPay.deposit, (address(tok), address(acct), 0)));
        assertEq(address(pay).balance, 1);
    }

    function test_ownerAndSessionCanCommitAndTerminate() public {
        _execAs(userPk, address(reg), abi.encodeCall(LRegistry.commit, (bytes32(0), bytes32(0), "x", 0)));
        _execAs(userPk, address(fwss), abi.encodeWithSignature("terminateService(uint256)", uint256(1)));
        _addSession();
        _execAs(sessPk, address(reg), abi.encodeCall(LRegistry.commit, (bytes32(0), bytes32(0), "y", 0)));
        assertEq(reg.n(), 2);
    }

    function test_addRemoveSessionOwnerOnly() public {
        _addSession();
        _execAs(userPk, address(acct), abi.encodeCall(LockedSignerAccountV2.removeSessionKey, (sess)));
        assertEq(acct.sessionSigners(sess), 0);
    }

    function test_sweepOnlyAdminToTreasury() public {
        vm.prank(user); vm.expectRevert(LockedSignerAccountV2.NotAdmin.selector); acct.sweep(1);
        vm.prank(admin); acct.sweep(60);
        assertEq(pay.bal(treasury), 60); assertEq(pay.bal(address(acct)), 40);
    }

    function test_poolAssign() public {
        vm.prank(admin);
        LockedSignerAccountV2 p = f.createPooled(7, EXP);
        assertTrue(p.unassigned());
        vm.prank(admin);
        f.assign(p, user, 0, 0, 0);
        assertFalse(p.unassigned());
        assertEq(p.owner(), user);
    }

    function test_beaconOwnerIsAdminAndCanUpgrade() public {
        UpgradeableBeacon b = f.beacon();
        assertEq(b.owner(), admin);
        address next = address(new LockedSignerAccountV2(address(f)));
        vm.prank(user);
        vm.expectRevert(NotOwner.selector);
        b.upgradeTo(next);
        vm.prank(admin);
        b.upgradeTo(next);
        assertEq(f.implementation(), next);
        // existing proxy still works after upgrade
        _execAs(userPk, address(reg), abi.encodeCall(LRegistry.commit, (bytes32(0), bytes32(0), "z", 0)));
        assertEq(reg.n(), 1);
    }

    function test_handBeaconToLedgerAddress() public {
        address ledger = address(0x123456);
        UpgradeableBeacon b = f.beacon();
        vm.prank(admin);
        b.transferOwnership(ledger);
        assertEq(b.owner(), ledger);
        address next = address(new LockedSignerAccountV2(address(f)));
        vm.prank(admin);
        vm.expectRevert(NotOwner.selector);
        b.upgradeTo(next);
        vm.prank(ledger);
        b.upgradeTo(next);
        assertEq(f.implementation(), next);
    }

    function test_factoryAdminIsIndependentOfBeaconOwner() public {
        address ledger = address(0x123456);
        UpgradeableBeacon b = f.beacon();
        vm.prank(admin);
        b.transferOwnership(ledger);
        vm.prank(admin);
        f.setTreasury(address(0xBEEF));
        assertEq(f.treasury(), address(0xBEEF));
        assertEq(f.admin(), admin);
        assertEq(b.owner(), ledger);
    }
}
