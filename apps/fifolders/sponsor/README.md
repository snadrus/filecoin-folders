# FiFolders sponsor (gasless mode)

The sponsor pays all gas. Users pay for storage by card through Stripe Checkout. After a signed webhook arrives, the
sponsor deposits the matching USDFC into the user's `LockedSignerAccount`. The account's fixed policy only lets that
USDFC pay FWSS storage. The only other way out is an admin `sweep` back to the treasury.

## Environment

| Variable | Where | Notes |
| --- | --- | --- |
| `SPONSOR_KEY` | sponsor | Gas wallet. It is also the factory admin and the treasury. |
| `SPONSOR_FACTORY` | sponsor | Address of `LockedSignerAccountFactory` (deploy it with `deploy.ts`). |
| `SPONSOR_NETWORK` | sponsor | `calibration` (default) or `mainnet`. |
| `STRIPE_SECRET_KEY` | sponsor | Calibration: `sk_test_…` only. Mainnet: `sk_live_…` only. |
| `STRIPE_WEBHOOK_SECRET` | sponsor | `whsec_…` from the Stripe endpoint for `POST /stripe/webhook`. Subscribe it to `checkout.session.completed` and `checkout.session.async_payment_succeeded`. |
| `SPONSOR_ALLOWED_ORIGINS` | sponsor | Comma-separated app origins allowed in Checkout redirects. Required on mainnet. |
| `SPONSOR_USDFC_PER_USD` | sponsor | Credit rate. Default `1`. |
| `SPONSOR_MIN_USD` / `SPONSOR_MAX_USD` | sponsor | Purchase bounds. Defaults are 1 and 200. |
| `SPONSOR_STRIPE_FAKE=1` | sponsor | Calibration only, and only when no Stripe key is set. Creates a local Checkout session; you then post a webhook signed with `STRIPE_WEBHOOK_SECRET` yourself. |
| `VITE_SPONSOR_URL` | app | Turns on gasless mode. |
| `VITE_SPONSOR_CREDIT_USD` | app | Default purchase. Default `5`. |
| `VITE_STRIPE_PUBLISHABLE_KEY` | app | Optional. Only used to check test vs live mode, since Checkout is a redirect. Calibration: `pk_test_…`. Mainnet: `pk_live_…`. |

For local testing with real test keys, run
`stripe listen --forward-to localhost:8787/stripe/webhook` to get a `whsec_…`, then pay with card `4242 4242 4242 4242`.

## Security

- **Request signing.** Every state-changing request (`/account`, `/checkout`, `/dataset`) carries an EIP-712
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
