# FiClub — on-chain groups

`contracts/src/FiClub.sol` + page `/ficlub/` (`apps/fifolders/ficlub/`, `src/ficlub/`).

## Model
- Club: `id` (1..clubCount), `name`, optional `metadata` bytes (e.g. a piece CID), `creator`, `createdAt`, `nonce`.
- **Two explicit lists**: `members` and `admins`. Admins are **not** implicitly members (`isMember` checks the members list only). The creator is put on both.
- Any admin: `addMember`, `removeMember`, `addAdmin`, `updateClub`.
- `removeAdmin(clubId, account)` (direct): only while the club has **≤ 2 admins**. Self-removal (stepping down) is allowed. The **last admin can never be removed**.
- `removeAdminWithSignatures(clubId, target, deadline, sig1, sig2)`: required when there are **> 2 admins**. Two EIP-712 signatures from **two distinct current admins** over
  `RemoveAdmin(uint256 clubId,address target,uint256 nonce,uint256 deadline)`, domain `{name:"FiClub", version:"1", chainId, verifyingContract}`.
  The **target may be one of the signers** (an admin may co-sign their own removal). Anyone may submit. Per-club `nonce` (bumped on every signature removal) prevents replay; `deadline` expires the signatures; low-s enforced.
- Views: `isMember`, `isAdmin`, `memberCount`, `adminCount`, `listMembers/listAdmins(clubId, offset, limit)`, `clubsOf(account, offset, limit)` / `clubsOfCount` (on-chain index of clubs where the account is a member or admin), `getClub`, `nonceOf`, `removeAdminDigest`, `domainSeparator`.
- Events: `ClubCreated`, `ClubUpdated`, `MemberAdded/Removed`, `AdminAdded/Removed`, `AdminRemovedBySignatures(clubId, account, signer1, signer2, nonce)`.

## UI (`/ficlub/`)
- List your clubs, Create Club, open a club: members + admins (FiPerson names/avatars), add/remove member, add admin.
- ≤ 2 admins: direct "Remove admin" / "Step down".
- ≥ 3 admins: "Remove admin — step 1: sign" → portable JSON blob (`kind: "ficlub/remove-admin"`: chainId, contract, clubId, target, nonce, deadline (7 days), signer1, sig1) with Copy + Download.
  "Import removal signature" (paste or file) validates network/contract/club/nonce/deadline/admins, shows what it does; a second, different admin co-signs (free) and submits (gas).
- Every wallet prompt shows a "Check your wallet — <what> · <cost>" toast.

## Config
- `VITE_FICLUB_ADDRESS_CALIBRATION` — deployed address. **Unset → "FiClub contract not deployed yet"** banner and an in-memory (localStorage) mock backend.
- Local chain: `VITE_FICLUB_ADDRESS_LOCAL`, `VITE_FICLUB_RPC`, `VITE_FICLUB_CHAIN_ID`.

## Tests
- `forge test --root contracts --match-contract FiClub` (replay, expired, duplicate signer, non-admin signer, target-as-signer allowed, last-admin protection, pagination, index).
- `pnpm --filter fifolders exec vitest run test/ficlub-core.test.ts` — blob/typed-data validation.
- `pnpm --filter fifolders exec playwright test e2e/ficlub.spec.ts` — mock backend + injected wallet.
- `pnpm --filter fifolders e2e:ficlub-anvil` — real contract on a local anvil chain (deploys with anvil's public test key).

## Deploy (Calibration) — not yet deployed
```
PRIVATE_KEY=... pnpm deploy:ficlub:calibration
# then set VITE_FICLUB_ADDRESS_CALIBRATION=<deployedTo> as a Pages build var and rebuild
```
Estimate (cast estimate, Nov 2026): ~96M FEVM gas × ~0.0002 nanoFIL/gas ≈ 0.00002 FIL (budget ≤ 0.01 FIL for fee-cap headroom). No constructor args.
