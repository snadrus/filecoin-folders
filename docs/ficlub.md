# FiClub — on-chain groups

`contracts/src/FiClub.sol` + page `/ficlub/` (`apps/fifolders/ficlub/`, `src/ficlub/`).

## Model
- Club: `id` (1..clubCount), `name`, optional `metadata` bytes (e.g. a piece CID), `creator`, `createdAt`, `nonce`.
- **Two explicit lists**: `members` and `admins`. Admins are **not** implicitly members (`isMember` checks the members list only). The creator is put on both.
- Any admin: `addMember`, `removeMember`, `addAdmin`, `updateClub`.
- `removeAdmin(clubId, account)` (direct): only while the club has **≤ 2 admins**. Self-removal (stepping down) is allowed. The **last admin can never be removed**.
- `removeAdminWithSignatures(clubId, target, deadline, sig1, sig2)`: required when there are **> 2 admins**. Two EIP-712 signatures from **two distinct current admins** over
  `RemoveAdmin(string purpose,uint256 clubId,address target,uint256 nonce,uint256 deadline)`, domain `{name:"FiClub", version:"2", chainId, verifyingContract}`.
  `purpose` is the fixed plain-language text `REMOVE_ADMIN_PURPOSE` = "Remove this admin from the FiClub", shown first in the wallet (v2; v1 had no purpose).
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

## Deployed (Calibration)
`0x412B9363019591588073B3489CB09d28d2a55A03` (v2, purpose field) — tx `0xa89a74e5…2f753`, block 4212873, gasUsed 76,767,897, ~0.000019 tFIL; verified on Sourcify (exact match) and Blockscout (see deployments/ficlub-calibration.json). Superseded v1: `0x4f73E1504d848eC4e3e74047940bD97EA79A3521`. Mainnet deploys go through /fideploy/ (artifacts regenerated). The page uses it by default; `VITE_E2E=1` keeps the mock backend.

## Deploy command
```
PRIVATE_KEY=... pnpm deploy:ficlub:calibration
# then set VITE_FICLUB_ADDRESS_CALIBRATION=<deployedTo> as a Pages build var and rebuild
```
Estimate (cast estimate, Nov 2026): ~96M FEVM gas × ~0.0002 nanoFIL/gas ≈ 0.00002 FIL (budget ≤ 0.01 FIL for fee-cap headroom). No constructor args.
