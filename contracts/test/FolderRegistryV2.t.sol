// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {FolderRegistryV2} from "../src/FolderRegistryV2.sol";
import {MockSessionKeyRegistry} from "./MockSessionKeyRegistry.sol";

contract FolderRegistryV2Test is Test {
    FolderRegistryV2 internal registry;
    MockSessionKeyRegistry internal keys;
    bytes32 internal constant NS = keccak256("fil-folders");
    bytes32 internal constant KEY = keccak256("demo");
    address internal writer = address(0xBEEF);
    address internal session = address(0x5E55);

    event Committed(address indexed owner, bytes32 indexed ns, bytes32 indexed key, bytes pieceCid, uint64 version);

    function setUp() public {
        keys = new MockSessionKeyRegistry();
        registry = new FolderRegistryV2(address(this), address(keys));
    }

    function test_emptyHead() public view {
        (bytes memory piece, uint64 version) = registry.head(address(this), NS, KEY);
        assertEq(piece.length, 0);
        assertEq(version, 0);
    }

    function test_commitAndOverwriteInPlace() public {
        registry.commit(NS, KEY, hex"aabbcc", 0);
        registry.commit(NS, KEY, hex"ddeeff", 1);
        (bytes memory piece, uint64 version) = registry.head(address(this), NS, KEY);
        assertEq(piece, hex"ddeeff");
        assertEq(version, 2);
    }

    function test_casOnVersion() public {
        registry.commit(NS, KEY, hex"aa", 0);
        vm.expectRevert(abi.encodeWithSelector(FolderRegistryV2.CasConflict.selector, bytes(hex"aa"), uint64(1)));
        registry.commit(NS, KEY, hex"bb", 0);
        vm.expectRevert(abi.encodeWithSelector(FolderRegistryV2.CasConflict.selector, bytes(hex"aa"), uint64(1)));
        registry.commit(NS, KEY, hex"bb", 2);
        (bytes memory piece,) = registry.head(address(this), NS, KEY);
        assertEq(piece, hex"aa");
    }

    function test_minimalEvent() public {
        vm.expectEmit(true, true, true, true);
        emit Committed(address(this), NS, KEY, hex"aa", 1);
        vm.recordLogs();
        registry.commit(NS, KEY, hex"aa", 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics.length, 4);
        (bytes memory piece, uint64 version) = abi.decode(logs[0].data, (bytes, uint64));
        assertEq(piece, hex"aa");
        assertEq(version, 1);
        assertEq(logs[0].data.length, 32 * 4); // offset, version, len, 1 word of piece — no prev, no timestamp
    }

    function test_writerFlow() public {
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(FolderRegistryV2.NotAuthorized.selector, writer, address(this), NS));
        registry.commitFor(address(this), NS, KEY, hex"aa", 0);
        registry.setWriter(NS, writer, true);
        assertTrue(registry.isWriter(address(this), NS, writer));
        vm.prank(writer);
        registry.commitFor(address(this), NS, KEY, hex"aa", 0);
        (, uint64 v) = registry.head(address(this), NS, KEY);
        assertEq(v, 1);
        (, uint64 wv) = registry.head(writer, NS, KEY);
        assertEq(wv, 0);
        registry.setWriter(NS, writer, false);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(FolderRegistryV2.NotAuthorized.selector, writer, address(this), NS));
        registry.commitFor(address(this), NS, KEY, hex"bb", 1);
    }

    function test_sessionKey() public {
        bytes32 perm = registry.PERMISSION_COMMIT();
        keys.setExpiry(address(this), session, perm, block.timestamp);
        vm.prank(session);
        registry.commitFor(address(this), NS, KEY, hex"aa", 0);
        vm.warp(block.timestamp + 1);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(FolderRegistryV2.NotAuthorized.selector, session, address(this), NS));
        registry.commitFor(address(this), NS, KEY, hex"bb", 1);
        keys.setExpiry(address(this), session, keccak256("other"), block.timestamp + 100);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(FolderRegistryV2.NotAuthorized.selector, session, address(this), NS));
        registry.commitFor(address(this), NS, KEY, hex"bb", 1);
    }

    function test_sessionKeyStillCas() public {
        keys.setExpiry(address(this), session, registry.PERMISSION_COMMIT(), block.timestamp + 100);
        registry.commit(NS, KEY, hex"aa", 0);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(FolderRegistryV2.CasConflict.selector, bytes(hex"aa"), uint64(1)));
        registry.commitFor(address(this), NS, KEY, hex"bb", 0);
    }

    function test_zeroAndLimits() public {
        vm.expectRevert(FolderRegistryV2.ZeroAddress.selector);
        registry.commitFor(address(0), NS, KEY, hex"aa", 0);
        vm.expectRevert(FolderRegistryV2.ZeroAddress.selector);
        registry.setWriter(NS, address(0), true);
        bytes memory big = new bytes(129);
        vm.expectRevert(abi.encodeWithSelector(FolderRegistryV2.PieceCidTooLarge.selector, uint256(129)));
        registry.commit(NS, KEY, big, 0);
        registry.commit(NS, KEY, new bytes(128), 0);
    }

    function test_versionOverflow() public {
        // slot of _heads[this][NS][KEY]: version is packed in slot+1
        bytes32 s = keccak256(abi.encode(KEY, keccak256(abi.encode(NS, keccak256(abi.encode(address(this), uint256(0)))))));
        vm.store(address(registry), bytes32(uint256(s) + 1), bytes32(uint256(type(uint64).max)));
        vm.expectRevert(FolderRegistryV2.VersionOverflow.selector);
        registry.commit(NS, KEY, hex"aa", type(uint64).max);
    }

    function test_admin() public {
        vm.prank(writer);
        vm.expectRevert(FolderRegistryV2.NotContractOwner.selector);
        registry.setSessionKeyRegistry(writer);
        registry.setSessionKeyRegistry(writer);
        assertEq(address(registry.sessionKeyRegistry()), writer);
        registry.setOwner(writer);
        assertEq(registry.owner(), writer);
    }

    function test_commitGasCeiling() public {
        bytes memory piece = new bytes(64);
        uint256 g = gasleft();
        registry.commit(NS, KEY, piece, 0);
        assertLt(g - gasleft(), 120_000);
    }

    function testFuzz_sequence(uint8 count, bytes32 seed) public {
        count = uint8(bound(count, 1, 30));
        for (uint64 i; i < count; i++) registry.commit(NS, KEY, abi.encodePacked(keccak256(abi.encode(seed, i))), i);
        (, uint64 v) = registry.head(address(this), NS, KEY);
        assertEq(v, count);
    }

    function testFuzz_isolated(address a, bytes32 k1, bytes32 k2) public {
        vm.assume(a != address(this) && k1 != k2);
        registry.commit(NS, k1, hex"01", 0);
        (, uint64 v) = registry.head(address(this), NS, k2);
        assertEq(v, 0);
        (, v) = registry.head(a, NS, k1);
        assertEq(v, 0);
    }
}
