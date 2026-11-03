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
| S05 | Every wallet request says what it is for and what it costs. | Setup steps, Activity rows and the wallet toast read "<title> — <purpose> (<cost>)". | mock + live |
| S06 | Session-key authorization is one labeled pop-up. | "Authorize session key — lets FiFolders save for 7 days without asking each time (~0.05 FIL)"; after approval the note clears and the signature count is 1. | mock |
| S07 | I can see what happened on chain. | Transaction-log sidebar toggles and lists chain steps; finished Activity rows show a blue progress bar and auto-dismiss after ~10 s. | mock |
| S08 | My dataset choice sticks. | Selecting a dataset in the account menu survives reload. | mock |
| S09 | Loose pieces add up. | "N pieces: X in folders, Y manifests, Z loose" with X+Y+Z = N and Z rows listed; hidden when nothing is loose. | mock |
| S10 | Refresh keeps my tree. | A folder created before reload is listed after reload. | mock |
| S10b | A fresh browser/origin recovers my tree from chain (FolderRegistry manifest). | New profile, same wallet → same tree. | blocked (test wallet has no committed volume; creating one spends) |
| S11 | Old links still work. | `/felarumi/…` → `/fipen/…`, `/felanumio/…` → `/figrid/…`, query and hash preserved. | mock |
| S40 | Slow signature. | "Check your wallet — <request> (<cost>)" toast while waiting; UI stays usable; toast clears afterwards. | live |
| S41 | I reject a signature. | Plain error with Retry (or Connect again); approving next time works; nothing stuck. | live |
| S42 | My wallet is locked. | Clear error; connect works after unlock. | live |
| S43 | Repeated clicks don't stack prompts. | Three clicks on Connect → one wallet request, one toast. | live |
| S44 | Wallet switches account or chain mid-session. | Account change → back to Connect (no stale signer); chain change → page restarts and asks (labeled) to switch back. | live |
| S45 | Payment approval, deposit, dataset creation, uploads on live. | Labeled, one prompt each, cost shown, results in Activity/Tx log. | blocked |

## FiPen / FiGrid inside FiFolders

| ID | Story | Acceptance criteria | Suite |
|---|---|---|---|
| S12 | New FiPen with no filename prompt. | New → FiPen document opens a tab, no dialog; title "Untitled document"; Save button + status sit right of the title, vertically aligned; status "All changes saved". | mock |
| S13 | Save works by button, Cmd+S and Ctrl+S. | Typing → "Unsaved changes"; each save → "Saved to Filecoin"; typing continues in the doc after clicking Save; drive shows no stale "Save pending". | mock |
| S14 | Autosave every 5 min only if dirty. | Clean doc: no save rows written; dirty doc: one save, then none while clean. (Interval shortened via `__p2pAutosaveMs`.) | mock |
| S15 | Reopening a saved doc shows its content. | Open the `.fipen` from the drive → same text; status not "Unsaved". | mock |
| S16 | Reload matrix (single user). | Dirty → reload: text kept, still "Unsaved changes". Queued (drive closed) → reload: "Queued for FiFolders". Drive back → "Saved to Filecoin", still after reload. | mock |
| S17 | Caret in the embedded editor. | Home/End/arrows/typing land correctly; caret survives Save. | mock |
| S18 | FiGrid cell edit, save, reload. | Click A1 → type 42 ⏎ → `=A1*2` ⏎ → A2 shows 84; Ctrl+S → "Saved to Filecoin"; reload keeps values and status; drive has the `.figrid`. | mock |
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
| S46 | FiPen signature function (Insert → Signature) with approve/reject/delay. | Labeled prompt; reject leaves the doc editable; approve locks it. | blocked (uploads the signed content) |
| S47 | Standalone FiPen "Save to Filecoin" with a wallet. | | blocked |
