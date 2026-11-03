# FolderRegistry v2 — minimal chain data

Calibration: `0x9C06335D7DE588Caa104ee4FC3bb7cd8Aba62443` (deployments/calibration-v2.json). v1 `0x4893…9331` stays as read-only history.

## Contract (`contracts/src/FolderRegistryV2.sol`)
- Storage unchanged: one `Head{pieceCid, version}` per `(owner, ns, key)`, overwritten in place.
- **CAS on `expectedVersion` (uint64)** instead of the previous piece CID: `commit(ns, key, pieceCid, expectedVersion)`, `commitFor(owner, ns, key, pieceCid, expectedVersion)`. Cheaper calldata (one word vs up to 128 bytes), same safety: any commit whose version is not the head's reverts. `CasConflict(currentPieceCid, currentVersion)` is unchanged, so clients still merge. The client also checks the observed piece against the head before sending.
- **Event `Committed(owner indexed, ns indexed, key indexed, bytes pieceCid, uint64 version)`** — no `prevPieceCid`, no `timestamp`.
- Writers and session keys unchanged. Session keys live in the shared SessionKeyRegistry (permission `keccak256("fil-folders.commit")`), so **existing session keys keep working on v2 with no re-authorization**. `setWriter` approvals made on v1 must be re-made on v2 (FiFolders does not use them).

## History lives on Filecoin
- Every new root manifest carries `prev` (previous root manifest piece CID, `""` for the first) and `t` (commit time, unix s).
- Identity profiles carry `prev` (previous profile piece CID).
- `Volume.history()` walks `prev` from the registry head (no `eth_getLogs`). At a pre-v2 manifest (no `prev`) it continues through the v1 `Committed` log scan (`prevPieceCid` links). Versions are numbered 1..n along the chain.

## Migration (automatic)
- `createViemRegistry({ address: <v1> })` returns a migrating registry when the v1 address has a known successor (`REGISTRY_SUCCESSORS`): `head` reads v2, falls back to v1; the first commit for a key still only on v1 CAS-checks the v1 head, then writes v2 at version 0; the new manifest's `prev` = the v1 head. `migrate: false` pins plain v1; `abiVersion: 2` talks to v2 directly.
- FiFolders labels that one-time write "Move folders pointer to new registry" / "Move identity pointer to new registry" (gas ~0.01 FIL) via `wrapMigration`. With a session key it is silent (the session key pays gas).
- fiperson `registryHeadReader(rpc, v1)` reads v2 first, then v1.
- Encryption keys still derive from the **v1** address (`registryAddress`), so encrypted volumes keep their keys.
- FiPen/FiGrid get this through the fil-folders/fiperson dist copied in the Pages build.

## Tests
- `forge test --root contracts` — FolderRegistryV2.t.sol: version CAS, minimal event bytes, writers, session keys, limits, overflow, fuzz.
- fil-folders: `test/migration.test.ts` (memory) and the anvil test (real v1 + v2: migrate a volume, linked history, minimal event, session key on v2).
- fiperson: `test/registry-v2.test.ts` (v2-first head reader, profile `prev`).
