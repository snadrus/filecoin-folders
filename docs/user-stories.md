# FiFolders · FiPen · FiGrid user stories

Each story has an ID used by the Playwright suite in `apps/fifolders/e2e-stories/` (test titles start with the ID).
Suites: **mock** = local build with the mock chain (`VITE_E2E=1`) + staged editors; **live** = injected EIP-1193 wallet on Calibration against `STORIES_URL`; **both** = editor-only stories that run anywhere.
`blocked` = needs Andy's approval to spend (payment approval, deposit, dataset creation, uploads, deployments).

## FiFolders: first visit, wallet, signing

| ID | Story | Acceptance criteria | Suite |
|---|---|---|---|
| S01 | As a new visitor I see what storage costs only when I ask. | No cost pop-up on first visit. The storage/runway widget sits bottom-left; clicking it opens "What it costs" with exactly: "Per month:", "$2.50/TiB = a penny for 4 GB", "$0.12 per dataset ($0.50 at start)", "A penny per piece added". Esc/×/backdrop closes. | mock |
| S02 | As any user I get the light theme. | `data-theme="light"` and a light background even when the OS prefers dark. | mock |
| S03 | As a user I connect my wallet. | One `eth_requestAccounts`; short address shown; drive visible. | live |
| S04 | As a user I can browse while setup transactions are pending. | Drive, Recent, Trash navigable; note "Finishing wallet setup… you can browse meanwhile"; pending step labeled "<title> — <purpose> (<cost>)"; edits made meanwhile are staged, not lost. | mock + live |
| S05 | Every wallet request says what it is for and what it costs. | Setup steps and the wallet toast read "<title> — <purpose> (<cost>)". Transaction log rows are titled by purpose only ("Save “Notes” to My Drive", "Authorize this browser to save", "Add 3 Filecoin Drive files"; never "Send transaction"/gas); cost is the secondary line. | mock + live |
| S06 | Session-key authorization is one labeled pop-up. | "Authorize session key — lets FiFolders save for 7 days without asking each time (~0.05 FIL)"; after approval the note clears and the signature count is 1. | mock |
| S07 | I can see what happened on chain. | One "Transaction log" sidebar entry (spinner + pending count while anything is pending) opens the log: purpose rows, on-chain details; finished rows show a blue progress bar and auto-dismiss after ~10 s. A lapsed/expiring session is a pending "Reconnect wallet session" row with a Reconnect button (log opens itself on expiry) plus the wallet toast — no split panel or setup pop-up. | mock |
| S08 | My dataset choice sticks. | Selecting a dataset in the account menu survives reload. | mock |
| S09 | Loose pieces add up. | "N pieces: X in folders, Y manifests, Z loose" with X+Y+Z = N and Z rows listed; hidden when nothing is loose. Clicking Loose pieces switches view at once with a spinner/skeleton; rows appear as each piece resolves ("Reading pieces k of N…"). | mock |
| S10 | Refresh keeps my tree. | A folder created before reload is listed after reload. | mock |
| S10b | A fresh browser/origin recovers my tree from chain (FolderRegistry manifest). | New profile, same wallet → same tree. | live (spend: STORIES_SPEND=1) |
| S11 | Old links still work. | `/felarumi/…` → `/fipen/…`, `/felanumio/…` → `/figrid/…`, query and hash preserved. | mock |
| S40 | Slow signature. | "Check your wallet — <request> (<cost>)" toast while waiting; UI stays usable; toast clears afterwards. | live |
| S41 | I reject a signature. | Plain error with Retry (or Connect again); approving next time works; nothing stuck. | live |
| S42 | My wallet is locked. | Clear error; connect works after unlock. | live |
| S43 | Repeated clicks don't stack prompts. | Three clicks on Connect → one wallet request, one toast. | live |
| S44 | Wallet switches account or chain mid-session. | No reload, no prompt: account change restarts the session in place for the new account; chain change shows a toast and the view stays; saving asks to switch back. | live |
| S45 | Payment approval, deposit, dataset creation, uploads on live. | Labeled, one prompt each, cost shown, results in Activity/Tx log. | live (spend: STORIES_SPEND=1) |

## FiPen / FiGrid inside FiFolders

| ID | Story | Acceptance criteria | Suite |
|---|---|---|---|
| S12 | New FiPen with no filename prompt. | New → FiPen document opens a tab, no dialog; title "Untitled document"; Save button + status sit right of the title, vertically aligned; status "New, unsaved" until the first Filecoin save. | mock |
| S13 | Save works by button, Cmd+S and Ctrl+S. | Typing → "Unsaved changes"; each save → "Saved to Filecoin"; typing continues in the doc after clicking Save; drive shows no stale "Save pending". | mock |
| S14 | Autosave every 5 min only if dirty. | Clean doc: no save rows written; dirty doc: one save, then none while clean. (Interval shortened via `__p2pAutosaveMs`.) | mock |
| S15 | Reopening a saved doc shows its content. | Open the `.fipen` from the drive → same text; status not "Unsaved". | mock |
| S16 | Reload matrix (single user). | Dirty → reload: text kept, still "Unsaved changes". Queued (drive closed) → reload: "Queued for FiFolders". Drive back → "Saved to Filecoin", still after reload. | mock |
| S17 | Caret in the embedded editor. | Home/End/arrows/typing land correctly; caret survives Save. | mock |
| S18 | FiGrid cell edit, save, reload. | A1 focused on open → type 42 (no click) ⏎ → `=A1*2` ⏎ → A2 shows 84; Ctrl+S → "Saved to Filecoin"; reload keeps values and status; drive has the `.figrid`. | mock |
| S19 | Stale chunk after a deploy. | Missing lazy chunk → "FiPen was updated. Reload the page to continue." with a Reload button that recovers. | mock |

## FiPen editing (standalone or embedded)

| ID | Story | Acceptance criteria | Suite |
|---|---|---|---|
| S20 | Typing and Enter keep the caret at the insertion point. | Real keystrokes; caret index and text asserted after each step. | both |
| S21 | Enter at line start/middle/end splits correctly. | | both |
| S22 | Arrows, Home/End, typing at line starts/ends across paragraphs. | | both |
| S23 | Backspace/Delete join paragraphs; caret at the join. | | both |
| S24 | Clicking past a line's end puts the caret at its end. | | both |
| S25 | Undo/redo restore text and caret. | | both |
| S26 | Share is just "🔗 Copy Link". | Share dialog has one button, no modes; copies a link with the room secret (#hash). | both |
| S27 | Comment via right-click; no quoted text. | Context menu → Comment → card shows the comment, not the selected text. | both |
| S28 | Mobile comment bubble. | Touch device + selection → "💬 Comment" bubble. | both |
| S29 | Guest names. | "Adjective Animal"; same wallet → same name (xoshiro128++ seed); different wallet → different name. | both |
| S30 | Display-name override. | FiFolders display name wins over the guest name; clicking your name opens the identity pop-up, whose "Just use a different name here" wins over both. | both |

## Two users (trystero over Nostr relays, two browser contexts)

| ID | Story | Acceptance criteria | Suite |
|---|---|---|---|
| S31 | Live co-editing. | Guest edits reach owner and vice versa; owner's caret shifts correctly under a remote insert; 2 avatars. | both |
| S32 | Owner-only resolve. | Guest sees owner's comment but no Resolve; owner resolves → gone for both. | both |
| S33 | Reload owner / guest / both. | Peers reconnect; text identical, no duplicates; comments kept; guest edits after reconnect reach the owner; caret sane. | both |
| S34 | Reload a clean standalone doc. | Content kept. | both |
| S35 | Leaving with unsaved changes warns. | `beforeunload` prompt. | both |
| S36 | Guest edits survive an owner reload. | Guest types, owner reloads, guest types again → both see each edit exactly once (no loss, no dupes). | both |
| S46 | FiPen signature function (Insert → Signature) with approve/reject/delay. | Labeled prompt; reject leaves the doc editable; approve locks it. | live (spend: STORIES_SPEND=1) |
| S47 | Standalone FiPen "Save to Filecoin" with a wallet. | Ctrl+S → dialog → Calibration → Save with wallet → PieceCID shown; status "Saved to Filecoin". | live (spend: STORIES_SPEND=1) |

## Suite features (added Nov 3 2026)

| ID | Story | Acceptance criteria | Suite |
|---|---|---|---|
| S48 | I save my identity with a picture on /identity/ and see it everywhere. | Save → read back on a fresh load; FiFolders header/owner column and FiPen show the name + avatar, not a guest name. Pointer commit re-reads the head and retries once on a CAS conflict. | live (spend) |
| S49 | Transaction log tells me what is happening. | One sidebar entry; spinner + count while pending; rows titled by purpose, cost secondary; finished rows auto-dismiss; errors show "!" and stay until dismissed; works at 390px width. | mock |
| S50 | Loose pieces with Filecoin Drive, then Add to drive. | Loose pieces lists Filecoin Drive files with names; select one or more → "Add to drive" names the count and cost before the wallet prompt; after commit the files appear in My Drive without re-uploading and leave Loose pieces. | mock + live (spend) |
| S51 | Registry v2 migration is one labeled step. | A drive whose head is only on v1 reads normally; the next save performs the move labeled "Move drive pointer to new registry" (session key, no root-wallet prompt); afterwards reads come from v2 and history links back to v1. | mock + anvil |
| S52 | FiClub add/remove and the 2-signature admin removal. | Admin adds/removes members and admins; removing an admin from a club with 3+ admins needs a step-1 signature (shareable blob) and a second admin's step-2 signature; expired/foreign blobs are rejected with a clear reason. | mock + anvil |
| S53 | FiPerson everywhere. | The same name + avatar for a wallet in the FiFolders header, owner column, account menu, FiClub member rows, FiPen/FiGrid avatars and the identity pop-up; guest name only when no identity exists. | mock + live |
| S54 | The dataset picker. | Wallet menu lists every dataset the wallet owns, current one checked, newest marked; switching reloads the drive in place with a loading state; choice survives reload (S08). | mock |
| S55 | Wallet & setup menu. | Shows account (FiPerson name, address secondary), network, dataset, session expiry, Add funds, Disconnect; every action that prompts says why and what it costs first. | mock |
| S56 | Switching account or network restarts in place. | accountsChanged → drive for the new account without reload or prompt; chainChanged → toast, view kept, save asks to switch back (S44). | mock + live |
| S57 | /fideploy/ shows contract status and deploys from my wallet. | Status per contract by known address + exact runtime-bytecode match; gas estimate after connecting; Deploy shows "Deploy <contract>" before the wallet prompt; after the receipt the new address is bytecode-verified and the deployments JSON can be copied/downloaded. | mock |
| S58 | Mainnet deploys need an explicit acknowledgement. | On chain 314 the Deploy buttons stay disabled until "I understand this … spends real FIL" is ticked. | mock |
| S59 | Private FiClub instance on Calibration via /fideploy/. | One contract-creation tx from the test wallet; record shows "✓ bytecode verified". | live (spend) |

### S61 Screen-reader names
As a screen-reader user, every button, link and field in FiFolders, Identity, FiClub and FiDeploy announces a name (no bare "button" or icon ligature text such as "more_vert").

### S62 Large uploads
As a user uploading a file of tens of MB, it appears in the drive right away and saves; if it is too big to back up across a tab close I'm told plainly to Save first (no raw "quota exceeded" error, no lost upload).

### S63 Keyboard-only file list
As a keyboard-only user, Tab takes me into the file list (one stop, like Drive), the focused row is selected and announced by name, and ↑/↓, Enter, F2 and Delete work from there.

### S64 Phone overlays
On a phone, with the Uploads panel open, the file menu and dialogs sit above it, so every menu item (Make a copy, Star, Move to trash, Details) can be tapped.
