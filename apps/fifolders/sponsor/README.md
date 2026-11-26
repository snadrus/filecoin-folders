# FiFolders sponsor (gasless mode)

The sponsor pays all gas. Users pay for storage by card through Stripe Checkout. After a signed webhook arrives, the
sponsor credits USDFC to the user's `LockedSignerAccount`. The account's fixed policy only lets that USDFC pay FWSS
storage. The only other way out is an admin `sweep` back to the treasury.

## Pricing

All amounts are in USD, and 1 USDFC is credited per $1.

| Item | Rule |
| --- | --- |
| Net | Charge minus Stripe's actual fee, read from the charge's balance transaction. |
| Credit | Net minus the $1.00 reserve, minus the $1.50 creation fee on the first purchase only; at least 1 USDFC. Reserve and creation fee stay off-chain and are owed to the sponsor (it paid for account and dataset creation); `/status` → `ledger` keeps the running total. |
| Minimum charge | $2.37 for a top-up, $3.91 for a first purchase (exact, to the cent), so that (charge − Stripe fee at 2.9% + 30¢) ≥ $2.00 ($1.00 reserve + 1 USDFC), plus the $1.50 creation fee. |
| Maximum | $200. The UI suggests $10 (a first $10 purchase credits 6.91 USDFC). |
| Balance floor | None. Users can spend their whole balance. |

The first purchase shows the setup fee as its own line item on the Stripe page.

## Warm pool (first purchase fast path)

The sponsor keeps `SPONSOR_POOL_SIZE` ready accounts (default 5). Each one is:
- created with `factory.createPooled`, with no owner;
- funded with 1 USDFC deposited in Filecoin Pay;
- given a dataset already open at an approved provider.

**On a first purchase:** one transaction, `factory.assign(account, owner, qx, qy, topUp)`, hands the account over. It
sets the buyer's wallet or passkey as owner. This can happen once, only by the admin, and only while the account is
unassigned. The same transaction deposits the part of the credit above the 1 USDFC already in the account. A credit
under 1 USDFC still gets the account; the sponsor absorbs the difference.

**Refill and fallback:** the pool refills in the background. If the pool is empty, the sponsor creates the account,
deposits the credit, and opens the dataset (the slow path).

## Environment

| Variable | Where | Notes |
| --- | --- | --- |
| `SPONSOR_KEY` | sponsor | Gas wallet and factory admin. The treasury is set at deploy (`SPONSOR_TREASURY`, default the sponsor). |
| `SPONSOR_FACTORY` | sponsor | Address of `LockedSignerAccountFactory` (deploy it with `deploy.ts`). |
| `SPONSOR_NETWORK` | sponsor | `calibration` (default) or `mainnet`. |
| `STRIPE_SECRET_KEY` | sponsor | Calibration: `sk_test_…` only. Mainnet: `sk_live_…` only. |
| `STRIPE_WEBHOOK_SECRET` | sponsor | `whsec_…` from the Stripe endpoint for `POST /stripe/webhook`. Subscribe it to `checkout.session.completed` and `checkout.session.async_payment_succeeded`. |
| `SPONSOR_ALLOWED_ORIGINS` | sponsor | Comma-separated app origins allowed in Checkout redirects. Required on mainnet. |
| `SPONSOR_USDFC_PER_USD` | sponsor | Credit rate. Default `1`. |
| `SPONSOR_RESERVE_USD` | sponsor | Default `1.00`. |
| `SPONSOR_MIN_CREDIT_USD` | sponsor | Minimum user credit per purchase. Default `1`. |
| `SPONSOR_SUGGESTED_USD` | sponsor | Recommended purchase returned by `/pricing`. Default `10`. |
| `SPONSOR_SETUP_FEE_USD` | sponsor | Creation fee (first purchase). Default `1.50`. |
| `SPONSOR_MIN_TOPUP_USD` / `SPONSOR_MIN_FIRST_USD` / `SPONSOR_MAX_USD` | sponsor | Defaults are `2.37`, `3.91`, and `200` (overrides can only raise the minimums). |
| `SPONSOR_MIN_NET_USD` / `SPONSOR_STRIPE_FEE_PCT` / `SPONSOR_STRIPE_FEE_FIXED_USD` | sponsor | Minimum net after Stripe's fee (default reserve + minimum credit = `2.00`; can only raise it) and the fee model (`2.9`, `0.30`). |
| `SPONSOR_MIN_FIL` | sponsor | FIL kept for gas. Below it, checkout and pool refill pause. Default `0.005`. |
| `SPONSOR_LOW_FIL` / `SPONSOR_LOW_USDFC` | sponsor | `/status` and `/health` report `low` below these. Defaults `0.05` and `20`. |
| `SPONSOR_REFUND_AFTER_HOURS` | sponsor | A paid credit still waiting for sponsor funds after this long is refunded through Stripe. Default `24`. |
| `SPONSOR_POOL_SIZE` / `SPONSOR_POOL_SEED_USDFC` | sponsor | Defaults are `5` and `1`. |
| `SPONSOR_STRIPE_FAKE=1` | sponsor | Calibration only, and only when no Stripe key is set. Creates a local Checkout session; you then post a webhook signed with `STRIPE_WEBHOOK_SECRET` yourself. |
| `VITE_SPONSOR_URL` | app | Turns on gasless mode. |
| `VITE_SPONSOR_CREDIT_USD` | app | Suggested purchase. Default: the sponsor's `suggestedUsd`, else `10`. |
| `VITE_STRIPE_PUBLISHABLE_KEY` | app | Optional. Only used to check test vs live mode, since Checkout is a redirect. Calibration: `pk_test_…`. Mainnet: `pk_live_…`. |

For local testing with real test keys, run
`stripe listen --forward-to localhost:8787/stripe/webhook` to get a `whsec_…`, then pay with card `4242 4242 4242 4242`.

## Security

- **Request signing.** Every state-changing request (`/checkout`, `/dataset`) carries an EIP-712
  `SponsorRequest(action, bodyHash, issuedAt)`. It must be signed by one of:
  - the owner wallet;
  - a live session key of the account (checked on chain);
  - the owner's passkey (WebAuthn).

  Requests expire after 5 minutes and cannot be replayed.
- **`/execute`.** Relays only to accounts the factory deployed (`factory.isAccount`). It checks `isAllowed`, then
  simulates, then sends. It is rate limited per account (default 30/min). Setup requests are limited per caller
  (20/h); checkout is limited to 10/h.
- **Webhooks.** They are verified with HMAC-SHA256 and a 5-minute tolerance. They are idempotent by Checkout Session
  id. `livemode` must match the network. The amount comes from Stripe's `amount_total`, not from client input.

## Funding guard and status

- **Checkout** first reads the sponsor's USDFC and FIL. It needs USDFC for this charge plus every credit still owed,
  and FIL at or above `SPONSOR_MIN_FIL`. If either is short, or the RPC fails, it answers 503 "Card payments are
  temporarily unavailable … you have not been charged". No Checkout session is created.
- **A payment that lands while the wallet is short** (a race) is parked as `awaiting-funds` before any transaction
  is sent. Because nothing was sent, a retry is always safe. The cron (`*/10`, or the Node server's 10-minute tick)
  retries it once funds arrive. After `SPONSOR_REFUND_AFTER_HOURS` it refunds the payment in full through Stripe,
  using an idempotency key per session.
- **The warm pool** refills after every handover and on each cron tick. Refill holds back whenever the wallet cannot
  cover owed credits plus a seed. With no ready account, a purchase falls back to on-demand creation.
- **Pool trimming.** When ready accounts exceed the target (for example after lowering `SPONSOR_POOL_SIZE`), the cron
  admin-sweeps the extra ones to the treasury (the sponsor on Calibration, so the USDFC is reused) and retires them.
  An account leaves `ready` before any await, so a purchase can never be handed one that is being swept. Entries
  stuck in `assigning` with no handover in flight are settled from the chain (`unassigned()`).
- **`GET /status`** returns the funds level (`ok`, `low`, `empty`, or `unknown`), FIL and USDFC balances, owed USDFC,
  thresholds, `checkoutOpen`, pool counts, credit counts by status, and `ledger` (reserve + creation fees owed to the sponsor). `/health` adds `funds` and `warnings`. The
  deploy workflow turns those warnings into run annotations.

## Ops

To return a sponsor-owned account's unspent funds to the factory treasury, run
`SPONSOR_KEY=0x… tsx apps/fifolders/sponsor/sweep.ts 0xAccount…`.

## Recovery (getting the operator's money back)

Everything the sponsor holds can be sent to the operator in one command. It is a dry run unless you add `--yes`:

```sh
SPONSOR_NETWORK=mainnet SPONSOR_KEY_FILE=/path/to/mainnet-sponsor.key \
RECOVERY_ADDRESS=f1ncgcm7zu25ouka3tnbvuscjcpl3spqg7rdl63wa \
RECOVERY_USDFC_ADDRESS=0x…            # optional; defaults to RECOVERY_ADDRESS
  tsx apps/fifolders/sponsor/recover.ts --factory 0xaaA1795A150BA01F7A5894A3D1A95334B695F067 \
  [--sweep 0xPooled1,0xPooled2] [--hand-admin] [--yes]
```

The steps run in this order:
1. Point the factory treasury at `RECOVERY_USDFC_ADDRESS`, if it is not already there.
2. Admin-sweep any `--sweep` accounts, such as unassigned pool accounts or terminated or unspent ones. Their Filecoin
   Pay USDFC goes to the treasury.
3. Transfer all of the wallet's USDFC.
4. Optionally (`--hand-admin`, 0x recipients only), hand factory admin to the recipient.
5. Send all FIL minus the final transaction's worst-case gas. Only the unused-gas refund (dust) stays behind.

Pause the Worker first, by setting `SPONSOR_POOL_SIZE_MAINNET=0` and removing mainnet from `VITE_SPONSOR_NETWORKS`,
so it does not spend while you drain.

You can give a Filecoin-native address (`f1…`, `f3…`, `f0…`) for either recipient. It resolves through
`StateLookupID` to its masked-ID form, `0xff00…<actor id>`. For example, `f1ncgcm7…` is `f03775120`, which is
`0xff00000000000000000000000000000000399a90`.
- **FIL** sent there arrives in the f1 account. This was verified live on Calibration by
  `test/recover-calibration.test.ts`.
- **USDFC** (an ERC-20) is credited to the masked-ID address. An f1 holder can move it only with
  `lotus evm invoke`, so prefer a 0x `RECOVERY_USDFC_ADDRESS`.

The mainnet factory was deployed with `treasury = 0xff00…399a90` (f03775120). Every admin sweep therefore returns
there already, and `setTreasury` can retarget it. The factory, the locked accounts, and the recovery steps are
covered by `contracts/test/LockedSignerAccount.t.sol` (`test_recoveryTreasuryReceivesSweeps`) and
`test/recover.test.ts`.
