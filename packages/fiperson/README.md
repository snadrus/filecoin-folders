# FiPerson

Wallet person/identity for FiFolders, FiPen and FiGrid. Two entry points:

| Entry | Who uses it | Dependencies |
|---|---|---|
| `fiperson/view` | FiFolders drive, FiPen, FiGrid | none (verified by `test/bundle.test.ts`: the view bundle contains only `src/view/*`, no edit code, < 20 kB min) |
| `fiperson/clubs` | `/identity/` (Find all my Clubs), FiPen | none (plain `eth_call`) |
| `fiperson/people` | FiPen @-mentions, `/person/` | none |
| `fiperson/notify` | FiPen Notify, `/identity/`, `/slack/callback/` | none (Slack Web API over `fetch`) |
| `fiperson/edit` | `/identity/` page only | none at runtime; you pass in a piece store (fil-folders `createSynapseStorage`) and a FolderRegistry client (`createViemRegistry`) |

`fiperson/edit` re-exports everything in `fiperson/view`.

## `fiperson/view`

- **Guest names:** `guestName(seed)`, `ADJECTIVES`, `ANIMALS`. "Adjective Animal" via xoshiro128++ seeded by splitmix32(FNV-1a(lowercased seed)), unbiased rejection sampling. Golden-tested; never change the lists or algorithm.
- **Schema:** `IdentityV1`, `normalizeIdentity`, `parseIdentity(bytes|json|object, expectedOwner?)`, `IDENTITY_NS`, `IDENTITY_PROFILE_KEY_ID`, `IDENTITY_CONTACTS_KEY_ID` (precomputed keccak), `IDENTITY_SCHEMA`, `DISPLAY_NAME_MAX`, `BIO_MAX`, `CALIBRATION_REGISTRY`, `CALIBRATION_RPC`, `IdentityError`, `isAddress`
- **Resolve:** `resolveIdentity(address, { head, fetchPiece, cache?, maxAgeMs?, force? })`, `cachedIdentity(address)` (sync), `readIdentityCache` / `writeIdentityCache` / `identityCacheKey` (`fil-identity:v1:<lowercase addr>`), `registryHeadReader(rpcUrl, registry)` (plain `eth_call`, no viem), `decodeHead`, `fetchPieceFromProviders(cid, urls, accept)`
- **Names and display:** `pickDisplayName({identityName, sessionName, legacyName, wallet, browserId})`. Precedence is identity → name typed this session → legacy `fifolders:display-name` → guest(wallet) → guest(browser id). Also `resolveDisplayName()` (wired to local/sessionStorage), `initials`, `avatarGlyph`, `avatarColors`, `AVATAR_COLORS`, `shortAddress`, `WALLET_KEY`, `BROWSER_ID_KEY`, `LEGACY_NAME_KEY`.
- **DOM:** `personChipHtml(person)`, `identityPopupHtml(opts)`, `openIdentityPopup(anchor, { person, href?, onLocalRename? })` ("Configure your identity" when there is none, otherwise the identity with Edit), `identityUrl(here)` (`../identity/?return=<here>`), `escapeHtml`.

## `fiperson/edit`

- `buildIdentity(address, draft)`, `encodeIdentity(doc)` (JSON space-padded to 127 bytes)
- `saveIdentity(doc, { storage, registry, withIntent?, onStep? })` stores the piece, then CAS-commits `(owner, fil-identity, profile)`
- `savePointedPiece(owner, bytes, { …, key })` is the generic version, used by the future address book (`IDENTITY_CONTACTS_KEY_ID`, `ContactsV1`)
- `IDENTITY_INTENTS` labels the wallet prompts with what and cost: "Store identity piece" (free signature, bytes billed from the deposit), "Link identity to wallet" (gas ~0.01 FIL)
- `assertStorageReady({ funds, approved, datasetId })` throws `IdentityBlocked`. FiPerson never deposits, approves payments or creates datasets.

Schema and on-chain layout: [docs/identity.md](../../docs/identity.md).

## `fiperson/clubs`

- `findMyClubs(address, { call?, contract? })` scans FiClub (`clubsOf`, `getClub`, `listMembers`, `listAdmins`; default Calibration `0x4f73E1504d848eC4e3e74047940bD97EA79A3521`) and caches `{ clubs, coworkers }` under `fiperson:clubs:v1:<addr>`. `cachedClubs`, `cachedCoworkers` read it back synchronously.

## `fiperson/people`

- `suggest(query, { participants? })` → `{ id, name, iconUrl, hint }[]`: your club-mates (from the cache above) plus the people the app passes (doc participants), ranked by name prefix. `needsClubScan()` is true until Find all my Clubs ran; apps then show a link to `findClubsUrl()`.
- `details(id)` → name, icon, bio, shared clubs, preferred notification contact + label, `url` (`personUrl(id)` → `/person/?id=`).

## `fiperson/notify`

- `notify(target, message, url)` → `{ ok: true, … } | { ok: false, reason, message, fallback }`. Call it from a click. Slack via PKCE user OAuth, see [docs/slack-app.md](../../docs/slack-app.md).
- `connectSlack({ team? })`, `handleSlackCallback()` (the `/slack/callback/` page), `slackConnections()`, `forgetSlackToken()`, `configureNotify({...})`, `SLACK_CLIENT_ID` (config.ts).
- `fiperson/notify/mock`: `createMockSlack()` for tests.
