# Fi → Tre rename: what changed and what deliberately did not

The product prefix `Fi` became `Tre` (FiFolders → TreFolders, FiPen → TrePen, FiGrid → TreGrid, FiPerson → TrePerson,
FiClub → TreClub, FiDeploy → TreDeploy, FiClubVault → TreClubVault). Lower-case and upper-case variants follow
(`trefolders`, `TREPEN_DIR`, `VITE_TRECLUB_RPC`). Repo names, the `fifolders.scionbase.ai` domain and the `fil-folders`
package did not change.

Run `scripts`-style check: `git grep -niP '(?<![a-z])fi(pen|grid|folders|person|club|deploy)'` lists exactly the strings below.

## Old live URLs keep working

| Old | New | How |
|---|---|---|
| `/fipen/`, `/figrid/` | `/trepen/`, `/tregrid/` | redirect pages written by `scripts/stage-editors.mjs`; deep links (`/fipen/d/<id>`) go through `404.html` |
| `/ficlub/`, `/fideploy/` | `/treclub/`, `/tredeploy/` | redirect pages in `apps/trefolders/public/` |
| `/felarumi/`, `/felanumio/` | `/trepen/`, `/tregrid/` | unchanged redirects, retargeted |

Every redirect keeps the query string and hash, so share links (`?room=…#key`) survive. `/identity/`, `/person/` and
the other pages never had a Fi prefix.

## Kept verbatim (data and protocols that live users, other tabs or deployed contracts depend on)

- **Old files and folders on Filecoin** still open and list: `.fipen` / `.figrid` files and the `/FiPen`, `/FiGrid`,
  `FiPerson` folders. New saves write `.trepen` / `.tregrid` into `/TrePen` and `/TreGrid` (identity pieces show under
  `TrePerson`), so version history of an older file does not continue under its new name.
- **Dataset metadata**: `source: "fifolders"`, `app: "fifolders"`, `volume: "FiFolders"`, system folder `.fifolders`.
- **Browser storage and cross-tab protocol**: every `fifolders:*`, `fipen:*`, `fiperson:*`, `ficlub:*`, `fideploy:*`
  localStorage key, BroadcastChannels `fifolders-ops` / `fiperson-slack`, IndexedDB `fiperson`, the `?fifolders=1`
  embed parameter and `data-fifolders` flags shared with collab-edit.
- **Signed or hashed text**: EIP-712 domains `FiClub` (v2), `FiPerson`, `FiFolders Sponsor`; the removal purpose
  `Remove this admin from the FiClub`; `MEMBER_KEY_PURPOSE`; key-derivation labels `fiperson/member-key/v1`,
  `fiperson/club-directory/v1`; blob kind `ficlub/remove-admin`; FEE group names `FiPerson/identity` and `FiFolders/v…`.
- **Contracts**: Solidity files and contract names are renamed (`TreClub.sol`, `TreClubVault.sol`), but string literals
  compiled into deployed code are not. Deployed addresses and `deployments/*.json` contents are untouched (files were
  renamed only). Because the source path changed, a fresh compile has different metadata than the deployed bytecode;
  Sourcify "exact match" verification for the old deployments is unaffected, new deployments get new metadata.
- **Infra names**: Cloudflare worker `fifolders-sponsor`, user agent `fifolders-sponsor/1`, drag-drop type
  `application/x-fifolders-paths`, window name `fifolders-limited-wallet`.
- `scripts/collab-edit-p2p.patch` (applies only to ancient collab-edit refs) is untouched.

TreGrid clipboard HTML attributes `data-figrid-origin` / `data-figrid-raw` were later renamed to
`data-tregrid-origin` / `data-tregrid-raw` in collab-edit (no compatibility read; there were no active
copy buffers).

## Build and CI

- `apps/fifolders` → `apps/trefolders`, `packages/fiperson` → `packages/treperson`, `@fifolders/sponsored-client` →
  `@trefolders/sponsored-client`. GitHub Pages still publishes `apps/trefolders/dist` with the same CNAME.
- Transition: `pages.yml` installs this commit's `treperson` and sponsored-client dist under both the new and the old
  package names for the collab-edit build, so a collab-edit ref from before its rename still builds. Remove the block
  once collab-edit `p2p` imports the new names.
