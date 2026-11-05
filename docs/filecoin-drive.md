# Filecoin Drive compatibility (FiFolders, FiPen, FiGrid, FiPerson)

Sources: [filecoin-pin](https://github.com/filecoin-project/filecoin-pin) (`src/core/synapse/constants.ts`, `src/core/upload/synapse.ts`),
[Filecoin Drive / filecoin-pin-website](https://github.com/filecoin-project/filecoin-pin-website)
(`src/hooks/use-filecoin-upload.ts`, `src/lib/filecoin-pin/drive-api.ts`, `drive-metadata.ts`, `delete.ts`, `download.ts`),
Synapse SDK `METADATA_KEYS` and `METADATA_LIMITS` (`@filoz/synapse-core/utils/metadata`).

## How Filecoin Drive names files
- One upload = one piece: a CAR holding a UnixFS file (or directory).
- Piece metadata: `label` = file name (Drive also reads `name`), `path` = folder (`carPath` for imported CARs),
  `ipfsRootCID` = UnixFS root. Name and folder are each at most 96 UTF-8 bytes.
- Data-set metadata: `source: "filecoin-pin"` and `withIPFSIndexing: ""`. Drive lists only data sets with
  `source === "filecoin-pin"` that the wallet owns (via the api.filecoin.io index).
- Synapse limits: 5 piece keys, 10 data-set keys, 32-byte keys, 128-byte values.

## How Filecoin Drive handles versions
It does not. Uploading the same name again adds a second piece; both rows are listed. There is no version
key, IPNS name or pointer. Delete is a user action that calls `deletePieces` (schedule removal) on every copy.
Nothing keeps history.

## What FiFolders writes
Each save is one commit piece (CAR: manifest root + new file bytes as raw `bafkrei` blocks). Its piece metadata:
- one plaintext file changed: `label` = file name, `path` = folder, `ipfsRootCID` = that file's raw CID, `version` = N.
  Drive downloads it as the file (it reads `ipfsRootCID` from the CAR).
- several files or only moves/renames: `label` = `<volume>.manifest.json`, `path` = `.fifolders`, `ipfsRootCID` = manifest root.
- encrypted volumes: only `version` (names stay private).

FiPerson profile pieces: `label: profile.json`, `path: FiPerson`, `version: N`.

Reading: FiFolders lists Drive pieces (by `label`/`name`, `path`/`carPath`, `ipfsRootCID`) and can add them to folders
without re-uploading. Pieces with `version` are older FiFolders versions, not loose uploads.

## Versions and retention
History is the commit chain (registry head → manifest `prev` → …), browsable in Manage versions.
Retention (Google Drive style): keep every version for 30 days and always the newest 100. Older versions the
live folder tree no longer uses are removed oldest-first, only when a save already schedules removals
(Delete forever). Delete forever also removes the deleted files' current pieces. If an old piece is gone,
history stops there and version numbers stay stable (counted down from the registry version).

Cost: storage is billed per byte per epoch, so a version costs its new bytes (the CAR holds only changed files
plus the small manifest). Removal is one `deletePieces` transaction per data set.
