// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FiClub} from "../src/FiClub.sol";
import {FiClubVault, IFiClubView} from "../src/FiClubVault.sol";

contract FiClubVaultTest is Test {
    FiClub club;
    FiClubVault vault;
    address admin = address(0xA11CE);
    address member = address(0xB0B);
    address outsider = address(0xC0C);
    address memberKey = address(0xBEEF);
    uint256 id;

    function setUp() public {
        club = new FiClub();
        vault = new FiClubVault(IFiClubView(address(club)));
        vm.startPrank(admin);
        id = club.createClub("Builders", "");
        club.addMember(id, member);
        vm.stopPrank();
    }

    function testFolderAndGrant() public {
        vm.startPrank(admin);
        vault.setFolder(id, hex"a1");
        vault.grant(id, member, memberKey, hex"0102", hex"03");
        vm.stopPrank();
        (bytes memory d, uint256 v) = vault.folderOf(id);
        assertEq(d, hex"a1");
        assertEq(v, 1);
        FiClubVault.Grant memory g = vault.grantOf(id, member);
        assertEq(g.memberKey, memberKey);
        assertEq(g.by, admin);
        assertEq(g.delivery, hex"0102");
        assertEq(g.entry, hex"03");
        address[] memory list = new address[](2);
        list[0] = member;
        list[1] = outsider;
        FiClubVault.Grant[] memory gs = vault.grantsOf(id, list);
        assertEq(gs[0].memberKey, memberKey);
        assertEq(gs[1].memberKey, address(0));
    }

    function testAdminCanGrantSelf() public {
        vm.prank(admin);
        vault.grant(id, admin, memberKey, hex"01", "");
        assertEq(vault.grantOf(id, admin).memberKey, memberKey);
    }

    function testOnlyAdmins() public {
        vm.prank(member);
        vm.expectRevert(FiClubVault.NotAdmin.selector);
        vault.setFolder(id, hex"a1");
        vm.prank(member);
        vm.expectRevert(FiClubVault.NotAdmin.selector);
        vault.grant(id, member, memberKey, hex"01", "");
        vm.prank(admin);
        vm.expectRevert(FiClubVault.NoClub.selector);
        vault.setFolder(99, hex"a1");
    }

    function testGrantNeedsClubMember() public {
        vm.prank(admin);
        vm.expectRevert(FiClubVault.NotInClub.selector);
        vault.grant(id, outsider, memberKey, hex"01", "");
    }

    function testRevokeAndLimits() public {
        vm.startPrank(admin);
        vault.grant(id, member, memberKey, hex"01", "");
        vault.revoke(id, member);
        assertEq(vault.grantOf(id, member).delivery.length, 0);
        vm.expectRevert(FiClubVault.Empty.selector);
        vault.grant(id, member, memberKey, "", "");
        vm.expectRevert(FiClubVault.ZeroAddress.selector);
        vault.grant(id, member, address(0), hex"01", "");
        vm.expectRevert(FiClubVault.TooLarge.selector);
        vault.setFolder(id, new bytes(4097));
        vm.stopPrank();
    }
}
