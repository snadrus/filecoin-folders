// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {LockedSignerAccountV2, LockedSignerAccountBeaconFactory} from "../src/LockedSignerAccountV2.sol";
import {LockedSignerAccountV3} from "../src/LockedSignerAccountV3.sol";
import {UpgradeableBeacon} from "../src/beacon/Beacon.sol";
import {LPay, LToken, LSKR, LReg, LFWSS, LRegistry} from "./LockedSignerAccountV2.t.sol";

contract LockedSignerAccountV3Test is Test {
    LPay pay; LToken tok; LSKR skr; LFWSS fwss; LRegistry reg;
    LockedSignerAccountBeaconFactory f; LockedSignerAccountV3 acct; LockedSignerAccountV3 impl;
    uint256 userPk = 0xA11CE; address user; address admin = address(0xAD); address treasury = address(0x7EA);
    address ledgerTreasury = address(0x1ED6E5);
    uint256 constant EXP = 2_000_000_000;
    uint256 sessPk = 0x5E55; address sess;
    bytes32 constant CREATE_DATA_SET = keccak256(
        "CreateDataSet(uint256 clientDataSetId,address payee,MetadataEntry[] metadata)MetadataEntry(string key,string value)"
    );

    function setUp() public {
        user = vm.addr(userPk);
        sess = vm.addr(sessPk);
        pay = new LPay(); tok = new LToken(); skr = new LSKR(); reg = new LRegistry();
        fwss = new LFWSS(address(pay), address(skr), address(tok), address(new LReg()));
        f = new LockedSignerAccountBeaconFactory(address(fwss), address(reg), admin, treasury);
        LockedSignerAccountV2 v2 = f.create(user, 0, 0, 0, EXP);
        pay.credit(address(v2), 100);
        impl = new LockedSignerAccountV3(address(f), ledgerTreasury);
        UpgradeableBeacon beacon = f.beacon();
        vm.prank(admin); // beacon owner in this test (the Ledger on Calibration and mainnet)
        beacon.upgradeTo(address(impl));
        acct = LockedSignerAccountV3(address(v2));
        // V2 state survives the upgrade.
        assertEq(acct.owner(), user);
        assertEq(acct.sessionExpiry(), EXP);
        assertEq(acct.TREASURY(), ledgerTreasury);
    }

    function _exec(uint256 pk, address target, bytes memory data) internal returns (bytes memory) {
        uint256 n = acct.nonce(); uint256 dl = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, acct.executeDigest(target, 0, data, n, dl));
        return acct.execute(target, 0, data, n, dl, abi.encodePacked(r, s, v));
    }

    function exec(uint256 pk, address target, bytes memory data) external { _exec(pk, target, data); }

    function _addSession() internal {
        _exec(userPk, address(acct), abi.encodeCall(LockedSignerAccountV3.addSessionKey, (sess, EXP)));
    }

    function _login(address key) internal pure returns (bytes memory) {
        bytes32[] memory p = new bytes32[](1);
        p[0] = CREATE_DATA_SET;
        return abi.encodeCall(LSKR.login, (key, EXP, p, "x"));
    }

    function test_sessionAndOwnerCannotLoginThirdPartyKeys() public {
        _addSession();
        bytes memory data = _login(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV3.CallNotAllowed.selector, address(skr), LSKR.login.selector));
        this.exec(sessPk, address(skr), data);
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV3.CallNotAllowed.selector, address(skr), LSKR.login.selector));
        this.exec(userPk, address(skr), data);
        assertEq(skr.authorizationExpiry(address(acct), address(0xBAD), CREATE_DATA_SET), 0);
    }

    function test_sessionAndOwnerCanRequestDataSetAtApprovedProviderOnly() public {
        _addSession();
        string[] memory none = new string[](0);
        bytes memory ok = abi.encodeCall(LockedSignerAccountV3.requestDataSet, (2, 77, none, none));
        address signer = abi.decode(_exec(sessPk, address(acct), ok), (address));
        assertEq(signer, acct.createDataSetSigner(77, address(uint160(0x5002)), none, none));
        assertEq(skr.authorizationExpiry(address(acct), signer, CREATE_DATA_SET), EXP);
        _exec(userPk, address(acct), abi.encodeCall(LockedSignerAccountV3.requestDataSet, (2, 78, none, none)));
        bytes memory bad = abi.encodeCall(LockedSignerAccountV3.requestDataSet, (9, 79, none, none));
        vm.expectRevert();
        this.exec(sessPk, address(acct), bad);
        vm.expectRevert(LockedSignerAccountV3.NotSelf.selector);
        acct.requestDataSet(2, 80, none, none);
    }

    function test_sessionStillCannotAddKeys() public {
        _addSession();
        bytes memory data = abi.encodeCall(LockedSignerAccountV3.addSessionKey, (address(0xBAD), EXP));
        vm.expectRevert(abi.encodeWithSelector(LockedSignerAccountV3.CallNotAllowed.selector, address(acct), LockedSignerAccountV3.addSessionKey.selector));
        this.exec(sessPk, address(acct), data);
    }

    function test_sweepOnlySpareOrRetiredToFixedTreasury() public {
        vm.prank(admin);
        vm.expectRevert(LockedSignerAccountV3.NotSweepable.selector);
        acct.sweep(10);
        // Changing the factory treasury no longer redirects sweeps.
        vm.prank(admin); f.setTreasury(address(0xEE));
        vm.prank(admin); LockedSignerAccountV2 spare = f.createPooled(1, EXP);
        pay.credit(address(spare), 50);
        vm.prank(admin); LockedSignerAccountV3(address(spare)).sweep(50);
        assertEq(pay.bal(ledgerTreasury), 50);
        assertEq(pay.bal(address(0xEE)), 0);
        // Retired: assigned to the admin itself.
        vm.prank(admin); LockedSignerAccountV2 retired = f.createPooled(2, EXP);
        vm.prank(admin); f.assign(retired, admin, 0, 0, 0);
        pay.credit(address(retired), 5);
        vm.prank(admin); LockedSignerAccountV3(address(retired)).sweep(5);
        assertEq(pay.bal(ledgerTreasury), 55);
    }

    function test_adminAddSessionKeyOnlyBeforeFirstExecute() public {
        vm.prank(admin); LockedSignerAccountV2 spare = f.createPooled(3, EXP);
        vm.prank(admin); f.assign(spare, user, 0, 0, 0);
        LockedSignerAccountV3 a = LockedSignerAccountV3(address(spare));
        uint256 n = a.nonce(); uint256 dl = block.timestamp + 60;
        bytes memory data = abi.encodeCall(LockedSignerAccountV3.addSessionKey, (sess, EXP));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, a.executeDigest(address(a), 0, data, n, dl));
        a.execute(address(a), 0, data, n, dl, abi.encodePacked(r, s, v));
        vm.prank(admin);
        vm.expectRevert(LockedSignerAccountV3.AccountInUse.selector);
        a.adminAddSessionKey(address(0xBAD), EXP);
    }
}
