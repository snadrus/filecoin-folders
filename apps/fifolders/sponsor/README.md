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

### Purchase waterfall

Every card payment is split in this order. The code calls the $1.00 transaction fee the "reserve" (`reserveCents`)
and the $1.50 creation fee `setupCents` (`pricing.ts` `creditFor`, `poolTopUp`).

**First purchase** (charge A):
1. **Stripe fee** goes to Stripe. This is the actual fee from the charge's balance transaction when Stripe returns it
   at webhook time (one attempt, no wait). Otherwise it's the 2.9% + 30¢ estimate.
2. **$1.50 account and dataset creation fee** stays in our Stripe balance.
3. **$1.00 transaction fee** stays in our Stripe balance.
4. **$1.00 for the 1 USDFC already in the spare account** we hand over (the pool seed). This stays in Stripe and
   repays the sponsor, which pre-funded that USDFC.
5. **The rest** is deposited as USDFC into the account in the same `factory.assign` transaction.

The user's wallet ends up holding steps 4 + 5 = A − Stripe fee − $2.50 (at least 1 USDFC). With no ready spare
(the slow path), steps 4 and 5 are deposited together as one deposit. The total is the same.

| Charge | Stripe fee | Creation | Tx fee | Pre-funded seed | Top-up deposited | Wallet total |
| --- | --- | --- | --- | --- | --- | --- |
| $3.91 (minimum) | $0.41 | $1.50 | $1.00 | 1 USDFC | 0 USDFC | 1.00 USDFC |
| $5.00 | $0.45 | $1.50 | $1.00 | 1 USDFC | 1.05 USDFC | 2.05 USDFC |
| $10.00 | $0.59 | $1.50 | $1.00 | 1 USDFC | 5.91 USDFC | 6.91 USDFC |

**Top-up** (an account already exists): Stripe fee, then the $1.00 transaction fee, then the rest is deposited.

| Charge | Stripe fee | Tx fee | Deposited |
| --- | --- | --- | --- |
| $2.37 (minimum) | $0.37 | $1.00 | 1.00 USDFC |
| $5.00 | $0.45 | $1.00 | 3.55 USDFC |
| $10.00 | $0.59 | $1.00 | 8.41 USDFC |

The minimums are set so the wallet always ends with at least 1 USDFC. On the minimum first purchase, that 1 USDFC is
the pre-funded seed, and the extra top-up is 0. If Stripe's real fee is higher than the estimate (for example an
international card), the difference comes out of the $1.00 transaction fee, never the user's 1 USDFC minimum.
`test/purchase-waterfall.test.ts` pins these numbers.

## Warm pool (first purchase fast path)

The sponsor keeps `SPONSOR_POOL_SIZE` ready accounts (2 on both Calibration and mainnet). Each one is:
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
| `SPONSOR_POOL_SIZE` / `SPONSOR_POOL_SIZE_MAINNET` / `SPONSOR_POOL_SEED_USDFC` | sponsor | Both networks keep 2 ready accounts (Calibration: `SPONSOR_POOL_SIZE`, mainnet: `SPONSOR_POOL_SIZE_MAINNET`). Seed default is `1`. |
| `SPONSOR_POOL_MIN_RUNWAY_DAYS` / `SPONSOR_POOL_TOPUP_MONTHS` / `SPONSOR_POOL_MAX_AGE_DAYS` | sponsor | Ready-spare rail: top up when runway is under 45 days (restore 3 months); retire spares older than 90 days. Same on both networks. |
| `SPONSOR_ALERT_FIL_WARN_FIL` / `SPONSOR_ALERT_FIL_CRITICAL_FIL` | sponsor | Cron emails when sponsor FIL is below these. Defaults `0.1` and `0.06`. |
| `SPONSOR_ALERT_USDFC_WARN` / `SPONSOR_ALERT_USDFC_CRITICAL` | sponsor | Optional USDFC floors. Unset = 2 spares at 3-month runway plus 3 minimum first purchases (warn), or 1 spare + 1 first purchase (critical). |
| `SPONSOR_ALERT_MIN_RUNWAY_DAYS` / `SPONSOR_ALERT_CRITICAL_RUNWAY_DAYS` | sponsor | Email when a ready spare's runway is below these. Defaults `45` and `7`. |
| `SPONSOR_ALERT_TO` / `SPONSOR_ALERT_FROM` | sponsor | Defaults `snadrus@gmail.com` and `sponsor@scionbase.ai`. |
| `SPONSOR_ALERT_REMINDER_HOURS` / `SPONSOR_ALERT_DISABLED` | sponsor | Daily reminder while low (default `24`). Set `SPONSOR_ALERT_DISABLED=1` to silence. |
| `RESEND_API_KEY` / `RESEND_FROM` | sponsor secret | Fallback mailer if the Email Routing `send_email` binding is not usable. |
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
- **`/execute`.** Relays only to factory accounts that have **paid** (an identity on the account or a Stripe credit
  that is not disputed/refunded); spares and unpaid accounts get 403 and a lifetime gas cap of 0. Order of checks:
  per-IP limit (120/min) → factory account → paid → not blocked → owner/session signature → per-account+signer limit
  (default 30/min) → target is not the SessionKeyRegistry (403; stops a session key or owner logging in an SP signer
  that could bill Filecoin Pay) → session `isAllowed` → simulate → trace. Gas limit = estimate × 1.3 (sent as the tx
  gas, so the relayer never re-estimates higher). A tx that is mined but reverts is **charged** to the account's
  budget; 3 mined reverts per account in 24 h block the account for 24 h, 5 per target in 24 h block the target for
  7 days. Setup requests are limited per caller (20/h); checkout is limited to 10/h per identity and 30/h per IP,
  open unpaid checkouts are capped at 5000 and expire after 48 h.
- **Stuck sponsor txs** are re-sent with the **same nonce** and bumped fees (never a fresh tx while the old nonce is
  open), so a dropped-then-mined deposit cannot be paid twice.
- **Disputes/refunds.** `charge.dispute.created` and `charge.refunded` mark the credit disputed and block gas for that
  account. Enable both events on the Stripe webhook endpoint (test and live).
- **Redirects** (`successUrl`/`cancelUrl`) must match an allowed origin by protocol, host, port and path prefix.
- **Sweeps** only touch spare (unassigned) or retired (owned by the sponsor) accounts, one relay attempt per run.
- **Accounts (V3, pending Ledger `upgradeTo`).** `LockedSignerAccountV3` refuses SessionKeyRegistry calls from the
  owner and session keys; datasets are opened via `requestDataSet(providerId, …)` only at FWSS-approved providers.
  Its treasury is immutable (`factory.setTreasury` no longer redirects sweeps) and `sweep` only works on spare or
  retired accounts. See `docs/beacon-upgrade.md`.
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
- **Pool runway.** On each cron tick (both networks) every unassigned ready account is checked against Filecoin Pay (`available` vs lockup rate, with a 1 USDFC/month floor). If runway is below `SPONSOR_POOL_MIN_RUNWAY_DAYS` (default 45), the sponsor deposits enough USDFC to restore `SPONSOR_POOL_TOPUP_MONTHS` (default 3). A spare older than `SPONSOR_POOL_MAX_AGE_DAYS` (default 90) is retired instead: the dataset is terminated, unspent funds are admin-swept, and the pool rebuilds a fresh account. Care respects the gas budget and the 0.05 FIL floor; `/status` lists each spare's runway and last action.
- **Pool trimming.** When ready accounts exceed the target (for example after lowering `SPONSOR_POOL_SIZE`), the cron
  admin-sweeps the extra ones to the treasury (the sponsor on Calibration, so the USDFC is reused) and retires them.
  An account leaves `ready` before any await, so a purchase can never be handed one that is being swept. Entries
  stuck in `assigning` with no handover in flight are settled from the chain (`unassigned()`).
- **Low-balance email.** Each cron tick (both networks) compares sponsor FIL, USDFC (minus owed credits), and ready-spare runway to the alert thresholds. Mail is edge-triggered in Durable Object state: one message on going low, one on recovery, and a daily reminder while low. Preferred delivery is the Cloudflare Email Routing `send_email` binding; `RESEND_API_KEY` is the fallback. Setup clicks and a forced-threshold test are in [`docs/sponsor-alerts.md`](../../../docs/sponsor-alerts.md).
- **`GET /status`** returns the funds level (`ok`, `low`, `empty`, or `unknown`), FIL and USDFC balances, owed USDFC,
  thresholds, `checkoutOpen`, pool counts (including spare runways), `alerts` (level, last email, send error), credit counts by status, and `ledger` (reserve + creation fees owed to the sponsor). `/health` adds `funds` and `warnings`. The
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

The v2 UpgradeableBeacon (account implementation upgrades) is owned by Andy's Ledger EOA `0xD62bD538bcEaB1284950E513f6Da796dD790642a`. Do not transfer it to the f1 masked-ID recovery address (it cannot sign EVM upgrade transactions). On Calibration the handover is `recover.ts --hand-beacon` or the `hand-beacon-calibration` workflow (dry run first, then `send=true`). After that, only the Ledger can call `upgradeTo`; the exact steps are in `docs/beacon-upgrade.md`. The sponsor-key workflow `upgrade-v2-beacon-calibration` will refuse.

```sh
SPONSOR_NETWORK=calibration SPONSOR_KEY_FILE=/path/to/calibration-sponsor.key \
  tsx apps/fifolders/sponsor/recover.ts \
  --factory 0x228867301f1f0EaF75b5d7af62F3c44e1796A56D \
  --hand-beacon 0xD62bD538bcEaB1284950E513f6Da796dD790642a [--yes]
```

`deployments/beacon-owner.json` is the intended owner for a mainnet v2 deploy: `deploy-v2.ts` transfers beacon ownership to that address immediately after deploy (no timelock). Deploy a Calibration v2 factory with `pnpm sponsor:deploy-v2`. Estimate only: `pnpm sponsor:deploy-v2:estimate`. After a new deploy, set `SPONSOR_FACTORY` to the new factory, `SPONSOR_FACTORY_LEGACY` to the previous factory, and `SPONSOR_BEACON` in wrangler.toml.

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

## Automatic USDFC refill (GEL-4)

Stripe USDC payout → Squid swap to USDFC on Filecoin when the mainnet sponsor is below a threshold. Dry-run by default; see [`docs/usdfc-refill.md`](../../../docs/usdfc-refill.md) for the secrets Andy must set and how to turn it on.
