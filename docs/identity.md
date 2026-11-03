# Wallet identity (`/identity/`)

One profile per wallet, shared by FiFolders, FiPen and FiGrid, and the base for a future address book.

## Where it lives

| Part | Value |
|---|---|
| Page | `https://fifolders.scionbase.ai/identity/` (own Vite entry `apps/fifolders/identity/index.html`, own bundle; not part of the drive UI). `?return=<same-origin URL>` sends the user back after Save. |
| Piece | JSON document stored with Synapse in the wallet's existing FiFolders dataset (same path as drive uploads). |
| Chain pointer | Existing **FolderRegistry** (`calibration 0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331`), `commit(ns, key, pieceCid, prevPieceCid)` from the wallet itself. No new contract. |
| `ns` | `keccak256("fil-identity")` (`identityNamespace()`) |
| `key` | `keccak256("profile")` (`identityProfileKey()`) |
| Read | `head(owner, ns, key)` → PieceCID (UTF-8) → fetch piece → `parseIdentity(bytes, owner)` |
| Cache | `localStorage["fil-identity:v1:<lowercase address>"] = { identity, pieceCid, version, checkedAt }`, shared by every app on the origin. Entries younger than 5 min skip the chain; a piece is only re-fetched when the pointer changes. |

The registry's compare-and-swap (`prevPieceCid`) and monotonically increasing `version` give history for free: every `Committed` event for `(owner, ns, key)` is a past profile.

## Schema v1 (`fil-identity/profile`)

```json
{
  "v": 1,
  "schema": "fil-identity/profile",
  "address": "0xabc…(lowercase, must equal the pointer owner)",
  "displayName": "Andy Jackson",
  "avatar": { "emoji": "🦊", "color": "#1a73e8" },
  "bio": "Builds things on Filecoin",
  "updatedAt": "2026-11-02T20:00:00.000Z"
}
```

- `displayName` required, 1–60 chars, whitespace collapsed, control chars stripped.
- `avatar.emoji` optional, one grapheme. `avatar.color` optional `#rrggbb`.
- `bio` optional, ≤ 280 chars.
- The JSON is space-padded to 127 bytes (minimum piece size); JSON parsers ignore it.
- Readers reject documents whose `address` does not match the pointer owner and **keep unknown fields**, so newer writers are not lossy. Breaking changes bump `v`.

## Address book (planned)

Same namespace, key `keccak256("contacts")` (`identityContactsKey()`), pointing at:

```json
{ "v": 1, "schema": "fil-identity/contacts", "address": "0xowner", "contacts": [ { "address": "0x…", "label": "Mom", "note": "" } ], "updatedAt": "…" }
```

Each contact's name/avatar resolves through `resolveIdentity(contact.address)`; `label` is the owner's private override (encrypt the piece if needed, as FiFolders does for encrypted volumes).

## Library: `packages/fiperson`

See packages/fiperson/README.md. Readers use `fiperson/view`; the /identity/ page uses `fiperson/edit`. The API list below is historical (it now lives in fiperson):

- `buildIdentity(address, draft)`, `parseIdentity`, `encodeIdentity` / `decodeIdentity`
- `resolveIdentity(address, { head, fetchPiece, cache?, maxAgeMs?, force? })` → `{ displayName, avatar, bio, source: "chain" | "cache" | "guest", identity, pieceCid, version }`
- `cachedIdentity(address)` — synchronous, no network
- `writeIdentityCache`, `readIdentityCache`, `identityCacheKey`
- `guestName(seed)` — deterministic "Adjective Animal" (xoshiro128++), the fallback everywhere
- `fetchPieceFromProviders(cid, urls, accept)` — `/piece/<cid>` fallback

## Costs and prompts

Save = (1) free EIP-712 signature to add the piece to the existing dataset (a few hundred bytes, billed from the existing storage deposit, far below $0.01/month) and (2) one `commit` transaction (gas ~0.01 FIL). The page never deposits, approves payments or creates a dataset: if those are missing it stops and links to FiFolders setup.
