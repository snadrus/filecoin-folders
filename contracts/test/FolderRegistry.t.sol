// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FolderRegistry} from "../src/FolderRegistry.sol";

contract FolderRegistryTest is Test {
    FolderRegistry internal registry;

    /// @dev Matches `namespaceId("fil-folders")` / `volumeKey("demo")` in the TypeScript package.
    bytes32 internal constant NS = keccak256("fil-folders");
    bytes32 internal constant KEY = keccak256("demo");

    event Committed(
        address indexed owner,
        bytes32 indexed ns,
        bytes32 indexed key,
        bytes pieceCid,
        bytes prevPieceCid,
        uint64 version,
        uint256 timestamp
    );

    event WriterSet(address indexed owner, bytes32 indexed ns, address indexed writer, bool allowed);

    function setUp() public {
        registry = new FolderRegistry();
    }

    function test_emptyHead() public view {
        (bytes memory piece, uint64 version) = registry.head(address(this), NS, KEY);
        assertEq(piece.length, 0);
        assertEq(version, 0);
        assertEq(registry.MAX_PIECE_CID_BYTES(), 128);
    }

    function test_commitAndRead() public {
        registry.commit(NS, KEY, hex"aabbcc", "");
        (bytes memory piece, uint64 version) = registry.head(address(this), NS, KEY);
        assertEq(piece, hex"aabbcc");
        assertEq(version, 1);

        registry.commit(NS, KEY, hex"ddeeff", hex"aabbcc");
        (piece, version) = registry.head(address(this), NS, KEY);
        assertEq(piece, hex"ddeeff");
        assertEq(version, 2);
    }

    function test_samePieceStillBumpsVersion() public {
        registry.commit(NS, KEY, hex"01", "");
        registry.commit(NS, KEY, hex"01", hex"01");
        (, uint64 version) = registry.head(address(this), NS, KEY);
        assertEq(version, 2);
    }

    function test_clearHead() public {
        registry.commit(NS, KEY, hex"aa", "");
        registry.commit(NS, KEY, "", hex"aa");
        (bytes memory piece, uint64 version) = registry.head(address(this), NS, KEY);
        assertEq(piece.length, 0);
        assertEq(version, 2);
    }

    function test_casConflictLeavesHeadUntouched() public {
        registry.commit(NS, KEY, hex"aabb", "");
        vm.expectRevert(abi.encodeWithSelector(FolderRegistry.CasConflict.selector, hex"aabb", uint64(1)));
        registry.commit(NS, KEY, hex"cc", hex"dd");

        (bytes memory piece, uint64 version) = registry.head(address(this), NS, KEY);
        assertEq(piece, hex"aabb");
        assertEq(version, 1);
    }

    function test_conflictOnFirstCommit() public {
        vm.expectRevert(abi.encodeWithSelector(FolderRegistry.CasConflict.selector, "", uint64(0)));
        registry.commit(NS, KEY, hex"01", hex"ff");
        (, uint64 version) = registry.head(address(this), NS, KEY);
        assertEq(version, 0);
    }

    function test_committedEvent() public {
        uint256 ts = 1_700_000_000;
        vm.warp(ts);
        vm.expectEmit(true, true, true, true, address(registry));
        emit Committed(address(this), NS, KEY, hex"abcd", "", 1, ts);
        registry.commit(NS, KEY, hex"abcd", "");
    }

    function test_independentSlots() public {
        registry.commit(NS, bytes32("a"), hex"01", "");
        registry.commit(NS, bytes32("b"), hex"02", "");
        registry.commit(keccak256("other"), bytes32("a"), hex"03", "");

        (bytes memory a,) = registry.head(address(this), NS, bytes32("a"));
        (bytes memory b,) = registry.head(address(this), NS, bytes32("b"));
        (bytes memory c,) = registry.head(address(this), keccak256("other"), bytes32("a"));
        assertEq(a, hex"01");
        assertEq(b, hex"02");
        assertEq(c, hex"03");
    }

    function test_ownerCommitForSelf() public {
        registry.commitFor(address(this), NS, KEY, hex"01", "");
        (, uint64 version) = registry.head(address(this), NS, KEY);
        assertEq(version, 1);
    }

    function test_ownerIsWriterWithoutApproval() public view {
        assertTrue(registry.isWriter(address(this), NS, address(this)));
        assertFalse(registry.isWriter(address(this), NS, address(0x1234)));
    }

    function test_ownerRemainsAuthorizedAfterSelfRevoke() public {
        registry.setWriter(NS, address(this), false);
        registry.commit(NS, KEY, hex"01", "");
        (, uint64 version) = registry.head(address(this), NS, KEY);
        assertEq(version, 1);
    }

    function test_writerCanCommitForAndIsRevoked() public {
        address writer = address(0xB0B);
        vm.expectEmit(true, true, true, true, address(registry));
        emit WriterSet(address(this), NS, writer, true);
        registry.setWriter(NS, writer, true);
        assertTrue(registry.isWriter(address(this), NS, writer));

        vm.prank(writer);
        registry.commitFor(address(this), NS, KEY, hex"01", "");

        registry.setWriter(NS, writer, false);
        assertFalse(registry.isWriter(address(this), NS, writer));

        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(FolderRegistry.NotAuthorized.selector, writer, address(this), NS));
        registry.commitFor(address(this), NS, KEY, hex"02", hex"01");

        (bytes memory piece, uint64 version) = registry.head(address(this), NS, KEY);
        assertEq(piece, hex"01");
        assertEq(version, 1);

        registry.setWriter(NS, writer, true);
        vm.prank(writer);
        registry.commitFor(address(this), NS, KEY, hex"02", hex"01");
        (, version) = registry.head(address(this), NS, KEY);
        assertEq(version, 2);
    }

    function test_writerIsNamespaceScoped() public {
        address writer = address(0xB0B);
        bytes32 other = keccak256("other");
        registry.setWriter(NS, writer, true);

        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(FolderRegistry.NotAuthorized.selector, writer, address(this), other));
        registry.commitFor(address(this), other, KEY, hex"01", "");
    }

    function test_writerCommitDoesNotWriteCallerHead() public {
        address writer = address(0xB0B);
        registry.setWriter(NS, writer, true);
        vm.prank(writer);
        registry.commitFor(address(this), NS, KEY, hex"01", "");

        (bytes memory ownerHead,) = registry.head(address(this), NS, KEY);
        (bytes memory writerHead, uint64 writerVersion) = registry.head(writer, NS, KEY);
        assertEq(ownerHead, hex"01");
        assertEq(writerHead.length, 0);
        assertEq(writerVersion, 0);
    }

    function test_strangerCannotCommitFor() public {
        address stranger = address(0xBEEF);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FolderRegistry.NotAuthorized.selector, stranger, address(this), NS));
        registry.commitFor(address(this), NS, KEY, hex"01", "");
        (, uint64 version) = registry.head(address(this), NS, KEY);
        assertEq(version, 0);
    }

    function test_unauthorizedDoesNotReportCas() public {
        address stranger = address(0xBEEF);
        registry.commit(NS, KEY, hex"01", "");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FolderRegistry.NotAuthorized.selector, stranger, address(this), NS));
        registry.commitFor(address(this), NS, KEY, hex"02", hex"ff");
    }

    function test_zeroOwnerAndWriter() public {
        vm.expectRevert(FolderRegistry.ZeroAddress.selector);
        registry.commitFor(address(0), NS, KEY, hex"01", "");
        vm.expectRevert(FolderRegistry.ZeroAddress.selector);
        registry.setWriter(NS, address(0), true);
    }

    function test_pieceCidLimit() public {
        bytes memory ok = new bytes(128);
        registry.commit(NS, KEY, ok, "");
        (bytes memory head,) = registry.head(address(this), NS, KEY);
        assertEq(head.length, 128);

        bytes memory big = new bytes(129);
        vm.expectRevert(abi.encodeWithSelector(FolderRegistry.PieceCidTooLarge.selector, uint256(129)));
        registry.commit(NS, KEY, big, ok);

        vm.expectRevert(abi.encodeWithSelector(FolderRegistry.PieceCidTooLarge.selector, uint256(129)));
        registry.commit(NS, KEY, hex"01", big);
    }

    function test_commitGasCeiling() public {
        bytes memory piece = new bytes(64);
        uint256 before = gasleft();
        registry.commit(NS, KEY, piece, "");
        uint256 used = before - gasleft();
        assertLt(used, 160_000);
    }

    function test_versionOverflow() public {
        bytes32 slot0 = keccak256(abi.encode(address(this), uint256(0)));
        bytes32 slot1 = keccak256(abi.encode(NS, slot0));
        bytes32 headSlot = keccak256(abi.encode(KEY, slot1));
        vm.store(address(registry), bytes32(uint256(headSlot) + 1), bytes32(uint256(type(uint64).max)));

        vm.expectRevert(FolderRegistry.VersionOverflow.selector);
        registry.commit(NS, KEY, hex"01", "");
        (, uint64 version) = registry.head(address(this), NS, KEY);
        assertEq(version, type(uint64).max);
    }

    function testFuzz_roundTrip(bytes calldata piece, bytes32 ns, bytes32 key) public {
        bytes memory stored = _trim(piece);
        registry.commit(ns, key, stored, "");
        (bytes memory head, uint64 version) = registry.head(address(this), ns, key);
        assertEq(head, stored);
        assertEq(version, 1);

        bytes memory next = _nextPiece(stored);
        registry.commit(ns, key, next, stored);
        (head, version) = registry.head(address(this), ns, key);
        assertEq(head, next);
        assertEq(version, 2);
    }

    function testFuzz_conflict(bytes32 a, bytes32 b, bytes32 c) public {
        vm.assume(a != b);
        registry.commit(NS, KEY, abi.encodePacked(a), "");
        vm.expectRevert(abi.encodeWithSelector(FolderRegistry.CasConflict.selector, abi.encodePacked(a), uint64(1)));
        registry.commit(NS, KEY, abi.encodePacked(c), abi.encodePacked(b));
        (bytes memory head, uint64 version) = registry.head(address(this), NS, KEY);
        assertEq(head, abi.encodePacked(a));
        assertEq(version, 1);
    }

    function testFuzz_sequence(uint8 count, bytes32 seed) public {
        uint256 n = bound(uint256(count), 1, 24);
        bytes memory prev = "";
        for (uint256 i = 0; i < n; i++) {
            bytes memory piece = abi.encodePacked(seed, bytes1(uint8(i)));
            registry.commit(NS, KEY, piece, prev);
            (bytes memory head, uint64 version) = registry.head(address(this), NS, KEY);
            assertEq(head, piece);
            assertEq(version, uint64(i + 1));
            prev = piece;
        }
    }

    function testFuzz_writers(address writer, bytes32 ns, bool allow) public {
        vm.assume(writer != address(0));
        registry.setWriter(ns, writer, allow);
        assertEq(registry.isWriter(address(this), ns, writer), allow || writer == address(this));
    }

    function testFuzz_isolatedOwners(address a, address b, bytes32 ns1, bytes32 ns2, bytes32 k1, bytes32 k2) public {
        vm.assume(a != address(0) && b != address(0));
        vm.assume(a != b || ns1 != ns2 || k1 != k2);

        vm.prank(a);
        registry.commit(ns1, k1, hex"01", "");
        vm.prank(b);
        registry.commit(ns2, k2, hex"02", "");

        (bytes memory ha,) = registry.head(a, ns1, k1);
        (bytes memory hb,) = registry.head(b, ns2, k2);
        assertEq(ha, hex"01");
        assertEq(hb, hex"02");
    }

    function _trim(bytes calldata data) internal pure returns (bytes memory out) {
        uint256 n = data.length > 128 ? 128 : data.length;
        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = data[i];
        }
    }

    function _nextPiece(bytes memory stored) internal pure returns (bytes memory next) {
        if (stored.length < 128) {
            next = new bytes(stored.length + 1);
            for (uint256 i = 0; i < stored.length; i++) {
                next[i] = stored[i];
            }
            next[stored.length] = 0x01;
            return next;
        }
        next = new bytes(stored.length);
        for (uint256 i = 0; i < stored.length; i++) {
            next[i] = stored[i];
        }
        next[0] = bytes1(uint8(next[0]) ^ 0x01);
    }
}
