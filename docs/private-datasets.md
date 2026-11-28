# Private folders (read-restricted data sets)

FiFolders can keep a volume in a **private** data set: the storage provider stores only encrypted pieces and
serves them only to a request signed by someone the owner authorized. This page records how that works on
Filecoin today, and how FiFolders uses it.

## How private data works on Filecoin (research, Nov 2026)

| Piece | What it is | Source |
| --- | --- | --- |
| FEE (Filecoin Encryption Envelope) | A COSE header (tag 16 `COSE_Encrypt0`, or tag 96 with recipients) followed by the ciphertext. Protected header: algorithm `-65793`, content type `application/vnd.filecoin-encryption+cose`, a 7-byte base nonce, chunk size, optional plaintext length and app metadata. Content is AES-256-GCM in 256 KiB chunks (STREAM: nonce = base ‖ chunk index ‖ last flag). | [FRC draft, FIPs#1294](https://github.com/filecoin-project/FIPs/pull/1294); TS [`filecoin-encryption-envelope`](https://www.npmjs.com/package/filecoin-encryption-envelope) ([source](https://github.com/FilOzone/synapse-sdk/tree/master/packages/filecoin-encryption-envelope)); Go port [`go-fee`](https://github.com/filecoin-project/go-fee) with shared vectors |
| Keysmith keys | One **group key** per owner, derived from an EIP-712 `GroupKey{owner, groupKeyId}` wallet signature (domain `Filecoin Encryption` v2) plus HKDF. **Groups** are slash paths (`FiPerson/identity`); holding a group's key opens it and every group below it. Each piece has a random salt; its key is `pieceKey(nodeKey, salt)`. The labels (`foc/v`, `foc/own`, `foc/gkid`, `foc/group`, `foc/salt`) ride in the envelope's app metadata, in the clear. | [`@filoz/keysmith`](https://www.npmjs.com/package/@filoz/keysmith) ([README](https://github.com/FilOzone/synapse-sdk/tree/master/packages/keysmith)) |
| Key wrapping | A **grant** wraps a node key (group key, group, or one piece) to a recipient's secp256k1 key by ECDH + AES-GCM; the descriptor is authenticated. Recipients publish `publicKeyOf(privateKey)` (a derived key-agreement key, not the address key). | keysmith `wrap.ts` |
| Read rights | A **claim chain**: an owner-signed EIP-712 `ReadGrant` root naming a node, a bearer address, an expiry and a delegation depth; each delegate can sign a narrower link (max 8). Claims cannot be revoked, only expire. A **Delivery** = chain + grant. | keysmith `claims.ts` |
| Curio enforcement | A data set created with metadata `read=restricted` is ACL'd. Every piece added must be a CAR with one root: a UnixFS file, or a directory whose single entry is `encrypted.fee`, starting with a valid envelope (`requireACLEnvelopes`). Restricted pieces are served only from `/download/<pieceCid or root CID>` with `Authorization: FOC-Grant <presentation>` (also accepted as cookie, basic-auth password, or `foc_grant` query): the presentation is the chain plus a `ReadRequest` for that piece signed by the final bearer, valid ≤ 300 s. No grant → `401 WWW-Authenticate: FOC-Grant`; a bad one → `403`. | Curio [#1617](https://github.com/filecoin-project/curio/pull/1617), [#1668](https://github.com/filecoin-project/curio/pull/1668); `pdp/fee_check.go`, `lib/keysmith/envelope.go`, `market/retrieval/piecehandler.go` (Curio `main`; not in v1.29.3) |
| Writers today | `filecoin-pin add --private` creates `read=restricted` data sets and uploads `encrypted.fee` CARs; `get` reads through `/download/`; private share links put a Delivery and a throwaway key in the URL fragment. | filecoin-pin [#827](https://github.com/filecoin-project/filecoin-pin/pull/827), [#840](https://github.com/filecoin-project/filecoin-pin/pull/840), [#841](https://github.com/filecoin-project/filecoin-pin/pull/841) (open); viewer [filecoin-encryption-viewer#19](https://github.com/FilOzone/filecoin-encryption-viewer/pull/19) |

Notes:

- **Filecoin Drive** (filecoin-pin-website, staging) encrypts with the same keys (`foc/enc=1`, default group
  key id) but its data sets stay publicly readable; the `read=restricted` path is in the filecoin-pin CLI and
  Curio `main`.
- On calibration, the providers that answer `/download/` today are ezpdpz (id 9), calib2 (id 2) and
  ca-test.660688.xyz (id 23). Their CORS allows the `Authorization` header.
- A second copy of a private piece currently fails (the secondary's pull from the primary is refused), so
  private volumes store **one copy**.
- The default group key id is `keccak256("filecoin/default-group-key" ‖ owner)[0:16]` in filecoin-pin,
  Filecoin Drive and FiFolders, so one wallet signature opens all three.

## How FiFolders uses it (`fil-folders/private`)

- **Visibility** — `datasetVisibility(metadata)`: `private` when `read=restricted`, `encrypted` when only
  `foc/enc` is set, otherwise `public`. `privateDataSetMetadata()` builds the metadata for a new private data set.
- **Packaging** — every piece of a private volume (the commit CAR the volume already writes) is FEE-encrypted
  under the volume's group `FiFolders/v<hash of the name>` (opaque: group names are public) and wrapped as
  `CAR { dir { "encrypted.fee": file } }` (`sealPiece`, `packFeeCar`). Curio's own `ReadEnvelopeLabels`
  accepts these CARs (checked with a 1 KB and a 2.5 MB multi-leaf piece).
- **Per-file keys** — inside the commit CAR, each file is encrypted with its own key,
  `HKDF(volumeKey, iv)`, and names with the volume key. A share link carries one file's key, so it opens that
  file only, not the folder's names or other files.
- **No wallet prompt per read** — at sign-in the wallet signs `GroupKey` and one `ReadGrant` naming the
  browser's session key (the same key the registry already authorizes). The Delivery is stored with the
  session (`createCredential` / `openCredential`); gated reads are signed by the session key
  (`fetchGated`).
- **Share links** — `makeFileShare` / `makeGroupShare` sign a claim to a fresh throwaway key T (the session
  delegates, no prompt) and wrap the piece's (or group's) key to T. Everything secret is in the URL
  **fragment** (`#v=pf1&…`), which browsers never send to a server. Links last a year by default and cannot
  be revoked before that.
- **FiPerson identity** — profiles in a private data set use group `FiPerson/identity`; the identity share
  link carries that group's key, so it keeps opening whatever profile version the registry points to.
- **Member keys** — `deriveMemberKey` turns a deterministic EIP-712 signature into a secp256k1 key whose
  wrap key and address go in the member's FiPerson profile. secp256k1 (not X25519) because Keysmith grants
  and Curio bearer signatures use it.

Only wallet (EOA) owners can make private folders: passkey and sponsored accounts cannot sign the `GroupKey`
message deterministically.
