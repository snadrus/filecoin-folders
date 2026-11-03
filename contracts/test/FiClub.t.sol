// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FiClub} from "../src/FiClub.sol";

contract FiClubTest is Test {
    FiClub club;
    uint256 aKey = 0xA11CE;
    uint256 bKey = 0xB0B;
    uint256 cKey = 0xC0C;
    uint256 dKey = 0xD0D;
    address a;
    address b;
    address c;
    address d;
    address m = address(0x1234);
    uint256 id;

    function setUp() public {
        club = new FiClub();
        a = vm.addr(aKey);
        b = vm.addr(bKey);
        c = vm.addr(cKey);
        d = vm.addr(dKey);
        vm.prank(a);
        id = club.createClub("Builders", hex"0155");
    }

    function _three() internal {
        vm.startPrank(a);
        club.addAdmin(id, b);
        club.addAdmin(id, c);
        vm.stopPrank();
    }

    function _sig(uint256 key, address target, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, club.removeAdminDigest(id, target, nonce, deadline));
        return abi.encodePacked(r, s, v);
    }

    function test_createMakesCreatorAdminAndMember() public view {
        assertTrue(club.isAdmin(id, a));
        assertTrue(club.isMember(id, a));
        assertEq(club.adminCount(id), 1);
        assertEq(club.clubsOf(a, 0, 10)[0], id);
        (string memory name,, address creator,,) = club.getClub(id);
        assertEq(name, "Builders");
        assertEq(creator, a);
    }

    function test_memberFlow() public {
        vm.expectEmit(true, true, true, false);
        emit FiClub.MemberAdded(id, m, a);
        vm.prank(a);
        club.addMember(id, m);
        assertTrue(club.isMember(id, m));
        assertEq(club.clubsOfCount(m), 1);
        vm.prank(a);
        vm.expectRevert(FiClub.AlreadyMember.selector);
        club.addMember(id, m);
        vm.prank(a);
        club.removeMember(id, m);
        assertFalse(club.isMember(id, m));
        assertEq(club.clubsOfCount(m), 0);
        vm.prank(a);
        vm.expectRevert(FiClub.NotMember.selector);
        club.removeMember(id, m);
    }

    function test_nonAdminCannotManage() public {
        vm.startPrank(m);
        vm.expectRevert(FiClub.NotAdmin.selector);
        club.addMember(id, b);
        vm.expectRevert(FiClub.NotAdmin.selector);
        club.addAdmin(id, b);
        vm.expectRevert(FiClub.NotAdmin.selector);
        club.removeAdmin(id, a);
        vm.stopPrank();
        vm.expectRevert(FiClub.NoClub.selector);
        club.addMember(99, b);
    }

    function test_adminsAreSeparateList() public {
        vm.prank(a);
        club.addAdmin(id, b);
        assertTrue(club.isAdmin(id, b));
        assertFalse(club.isMember(id, b));
        assertEq(club.clubsOfCount(b), 1);
    }

    function test_directRemoveOtherAndSelf() public {
        vm.prank(a);
        club.addAdmin(id, b);
        vm.prank(b);
        club.removeAdmin(id, a); // remove other
        assertFalse(club.isAdmin(id, a));
        assertTrue(club.isMember(id, a));
        vm.prank(b);
        club.addAdmin(id, a);
        vm.prank(a);
        club.removeAdmin(id, a); // self-removal allowed
        assertFalse(club.isAdmin(id, a));
    }

    function test_lastAdminProtected() public {
        vm.prank(a);
        vm.expectRevert(FiClub.LastAdmin.selector);
        club.removeAdmin(id, a);
    }

    function test_directRemoveBlockedWithThree() public {
        _three();
        vm.prank(a);
        vm.expectRevert(FiClub.NeedSignatures.selector);
        club.removeAdmin(id, c);
    }

    function test_sigRemove() public {
        _three();
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s1 = _sig(aKey, c, 0, dl);
        bytes memory s2 = _sig(bKey, c, 0, dl);
        vm.prank(m); // anyone submits
        club.removeAdminWithSignatures(id, c, dl, s1, s2);
        assertFalse(club.isAdmin(id, c));
        assertEq(club.nonceOf(id), 1);
        assertEq(club.clubsOfCount(c), 0);
    }

    function test_sigRemoveTargetMaySign() public {
        _three();
        uint256 dl = block.timestamp + 1 hours;
        club.removeAdminWithSignatures(id, c, dl, _sig(cKey, c, 0, dl), _sig(aKey, c, 0, dl));
        assertFalse(club.isAdmin(id, c));
    }

    function test_sigReplay() public {
        _three();
        vm.prank(a);
        club.addAdmin(id, d);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s1 = _sig(aKey, c, 0, dl);
        bytes memory s2 = _sig(bKey, c, 0, dl);
        club.removeAdminWithSignatures(id, c, dl, s1, s2);
        vm.prank(a);
        club.addAdmin(id, c);
        vm.expectRevert(FiClub.SignerNotAdmin.selector); // nonce moved -> recovers garbage signers
        club.removeAdminWithSignatures(id, c, dl, s1, s2);
    }

    function test_sigExpired() public {
        _three();
        uint256 dl = block.timestamp + 10;
        bytes memory s1 = _sig(aKey, c, 0, dl);
        bytes memory s2 = _sig(bKey, c, 0, dl);
        vm.warp(dl + 1);
        vm.expectRevert(FiClub.Expired.selector);
        club.removeAdminWithSignatures(id, c, dl, s1, s2);
    }

    function test_sigDuplicateSigner() public {
        _three();
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s1 = _sig(aKey, c, 0, dl);
        vm.expectRevert(FiClub.DuplicateSigner.selector);
        club.removeAdminWithSignatures(id, c, dl, s1, s1);
    }

    function test_sigNonAdminSigner() public {
        _three();
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s1 = _sig(aKey, c, 0, dl);
        bytes memory s2 = _sig(dKey, c, 0, dl);
        vm.expectRevert(FiClub.SignerNotAdmin.selector);
        club.removeAdminWithSignatures(id, c, dl, s1, s2);
    }

    function test_sigBadSignature() public {
        _three();
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s1 = _sig(aKey, c, 0, dl);
        vm.expectRevert(FiClub.BadSignature.selector);
        club.removeAdminWithSignatures(id, c, dl, s1, hex"1234");
    }

    function test_sigNeedsMoreThanTwoAdmins() public {
        vm.prank(a);
        club.addAdmin(id, b);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s1 = _sig(aKey, b, 0, dl);
        bytes memory s2 = _sig(bKey, b, 0, dl);
        vm.expectRevert(FiClub.TooFewAdminsForSignatures.selector);
        club.removeAdminWithSignatures(id, b, dl, s1, s2);
    }

    function test_sigTargetNotAdmin() public {
        _three();
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s1 = _sig(aKey, d, 0, dl);
        bytes memory s2 = _sig(bKey, d, 0, dl);
        vm.expectRevert(FiClub.NotAnAdmin.selector);
        club.removeAdminWithSignatures(id, d, dl, s1, s2);
    }

    function test_pagination() public {
        vm.startPrank(a);
        for (uint160 i = 1; i <= 5; i++) club.addMember(id, address(i + 100));
        vm.stopPrank();
        assertEq(club.listMembers(id, 0, 3).length, 3);
        assertEq(club.listMembers(id, 3, 10).length, 3);
        assertEq(club.listMembers(id, 10, 10).length, 0);
        assertEq(club.listAdmins(id, 0, 10)[0], a);
    }

    function testFuzz_neverZeroAdmins(uint8 n) public {
        vm.assume(n < 6);
        _three();
        // remove down to 2 with sigs, then direct down to 1, last stays
        uint256 dl = block.timestamp + 1;
        club.removeAdminWithSignatures(id, c, dl, _sig(aKey, c, 0, dl), _sig(bKey, c, 0, dl));
        vm.prank(a);
        club.removeAdmin(id, b);
        vm.prank(a);
        vm.expectRevert(FiClub.LastAdmin.selector);
        club.removeAdmin(id, a);
        assertEq(club.adminCount(id), 1);
    }

    /// Decision 5: the signed RemoveAdmin carries a fixed plain-language purpose (EIP-712 v2).
    function test_removeAdminDigestIncludesPurpose() public view {
        bytes32 typehash = keccak256("RemoveAdmin(string purpose,uint256 clubId,address target,uint256 nonce,uint256 deadline)");
        assertEq(club.REMOVE_ADMIN_TYPEHASH(), typehash);
        assertEq(club.REMOVE_ADMIN_PURPOSE(), "Remove this admin from the FiClub");
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("FiClub"), keccak256("2"), block.chainid, address(club)));
        bytes32 structHash = keccak256(abi.encode(typehash, keccak256("Remove this admin from the FiClub"), uint256(1), address(0xBEEF), uint256(0), uint256(99)));
        assertEq(club.removeAdminDigest(1, address(0xBEEF), 0, 99), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }
}
