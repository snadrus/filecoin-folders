# FiFolders

A static file manager on [`fil-folders`](../../packages/fil-folders). It keeps a folder volume on Filecoin: file bytes are pieces, and a Calibration `FolderRegistry` head points at the current manifest.

The build is plain Vite and TypeScript. `vite build` emits `dist/` with relative asset URLs, so any static host can serve it.

## Run

```bash
pnpm install
pnpm --filter fil-folders build
pnpm --filter fifolders dev
```

Connect an injected EIP-1193 wallet (MetaMask). The network toggle defaults to Calibration. Mainnet stays disabled until a FolderRegistry is deployed there.

| | |
| --- | --- |
| Calibration chain id | 314159 |
| Registry | `0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331` |
| Log scan start | block 4207373 |
| RPC | `https://api.calibration.node.glif.io/rpc/v1` |

Encryption is optional per volume. The choice is stored in the browser and applied the next time that volume is opened. Several uploads share one `tx()` commit. If another writer lands first, non-overlapping paths merge and a toast says so. A real path conflict names the paths and leaves the previous snapshot in place.

Trash is the `/.trash` folder. Restore uses the original path remembered in localStorage.

`.felarumi` and `.felanumio` files use their own icons and open in an app URL. Defaults are `https://felarumi.example` and `https://felanumio.example`. Override them in the account menu or with `VITE_FELARUMI_URL` and `VITE_FELANUMIO_URL`.

New → Felarumi document writes a blank document and opens it. New → Felanumio spreadsheet does the same for a sheet. The bytes are JSON the editors load:

```json
{ "v": 1, "type": "doc", "title": "Notes", "content": [{ "type": "paragraph", "text": "" }] }
```

```json
{ "v": 1, "type": "sheet", "title": "Budget", "sheets": [{ "name": "Sheet1", "cells": {} }] }
```

## Static host

```bash
pnpm --filter fifolders build
```

Serve `apps/fifolders/dist`. `base` is `./`. Pushes to `main` also publish that directory to GitHub Pages for `fidrive.scionbase.ai` (`.github/workflows/pages.yml`).

## Tests

```bash
pnpm --filter fifolders test
pnpm --filter fifolders e2e
```

Unit tests use vitest and happy-dom. The browser suite runs against an in-memory storage and registry (`VITE_E2E=1`), not a wallet.

## Mark

The logo is an original folder shape: a dark body, a `#0090FF` tab, and a `#0090FF` disc. It is not the Filecoin logo. Icons are [Material Symbols](https://github.com/google/material-design-icons) (Apache-2.0). Text is [Roboto](https://fonts.google.com/specimen/Roboto) (OFL). `.felarumi` and `.felanumio` icons are original SVGs in `src/icons.ts`.

## Screenshots

List, with Name, Owner, Last modified, and File size:

![FiFolders list](screenshots/list.png)

Grid:

![FiFolders grid](screenshots/grid.png)

Details, with Piece CID, version, and history:

![FiFolders details](screenshots/details.png)

## License

MIT, same as the rest of this repository.
