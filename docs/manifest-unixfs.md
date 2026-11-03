# Adopted Filecoin Drive (UnixFS) files in the FiFolders manifest

FiFolders can reference files that Filecoin Pin's **Filecoin Drive** already stored, without
re-uploading them ("Add to drive" in Loose pieces).

## Manifest fields (additive, `v: 1` unchanged)

A file entry may carry two optional fields:

| field      | value                                                                 |
|------------|-----------------------------------------------------------------------|
| `format`   | `"unixfs"`: bytes are a UnixFS DAG inside a CAR piece                  |
| `located`  | storage piece CID (the Filecoin Drive piece) that holds the CAR        |

With `format: "unixfs"`:

- `pieceCid` is the **UnixFS CID of the file** inside that CAR (raw leaf or dag-pb file node).
- `ipfs` is the IPFS root CID filecoin-pin recorded (`ipfsRootCID` piece metadata), when known.
- `importedCar: true` means the piece is a CAR the user imported as-is; the file **is** the whole
  piece and is served raw.
- No `enc`: adopted files are always plaintext, even in an encrypted volume. The UI marks them
  "Filecoin Drive · plaintext".

Example:

```json
{"format":"unixfs","ipfs":"bafkrei…","located":"bafkzcib…","mtime":1793677716601,
 "mime":"text/html","name":"index.html","pieceCid":"bafkrei…","size":812,"type":"file"}
```

Readers ignore unknown `format` values and absent fields, so older manifests are unaffected and
older readers still list adopted files (they cannot read their bytes).

## Reading

`Volume.get` fetches the `located` piece, parses the CARv1 and concatenates the UnixFS file
(`packages/fil-folders/src/unixfs.ts`). HAMT-sharded directories are not supported.

## Writing

`Volume.adopt([{ path, ref: { cid, piece, size, mime?, ipfs?, importedCar? } }])` places every
item in one compare-and-swap commit: one small manifest piece plus one registry commit
(gas ~0.01 FIL). No file bytes are uploaded.

## Pieces in another dataset

Allowed when the piece is readable (piece retrieval by CID from its provider). The adopted file
then depends on **that** dataset staying paid and not deleting the piece; FiFolders does not
schedule removal of `located` pieces it references, but cannot keep another dataset alive.
