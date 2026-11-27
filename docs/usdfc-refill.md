# Automatic USDFC refill (GEL-4)

When the Filecoin mainnet sponsor (`0xa69A4eF204eA951976bd6bDaCbd932Bbd18B08Db`) falls below a USDFC threshold, a GitHub Action plans a Stripe USDC payout to that same 0x on a Squid-supported chain (default: Base), then a Squid swap of USDC → USDFC on Filecoin, paid to the sponsor.

The workflow is **dry-run by default** and does not move money until Andy explicitly runs it with `send=true` after the secrets below are set.

## What Andy must enable

1. **Stripe payout permission.** In the live Stripe account, enable [stablecoin / crypto wallet payouts](https://docs.stripe.com/global-payouts/send-money/stablecoins) (US businesses; New York may need separate access). Use a restricted live key that can create outbound transfers / payout intents. Store it as GitHub secret `STRIPE_PAYOUT_KEY` (or reuse `STRIPE_LIVE_SECRET_KEY` if that key already has payout permission — do not put keys in the repo or Worker logs).
2. **Treasury / financial account** that holds USD or USDC from card payments. Store the account id as `STRIPE_FINANCIAL_ACCOUNT`.
3. **Crypto payout destination.** Register a USDC crypto-wallet payout method for the sponsor address `0xa69A4eF204eA951976bd6bDaCbd932Bbd18B08Db` on Base (default) or Ethereum. Store the payout method id (`cwa_…`) as `STRIPE_CRYPTO_PAYOUT_METHOD`.
4. **Squid integrator ID.** Request one at [docs.squidrouter.com](https://docs.squidrouter.com/getting-started/integrator-quickstart). Store it as `SQUID_INTEGRATOR_ID`.
5. **Source-chain gas.** The existing `SPONSOR_KEY_MAINNET` signs the Squid transaction from that same 0x on Base (or Ethereum). That address needs a little ETH on the source chain for gas. The key stays a GitHub secret; the script never prints it.
6. **Optional alert.** `REFILL_ALERT_WEBHOOK` (Slack incoming webhook or similar) receives a JSON post of each run, including dry-runs.

## Config (workflow inputs or env)

| Name | Default | Meaning |
| --- | --- | --- |
| `REFILL_THRESHOLD_USDFC` | `20` | Run a refill when Filecoin sponsor USDFC is below this. |
| `REFILL_TARGET_USDFC` | `50` | Fill toward this balance. |
| `REFILL_MAX_USDC_PER_RUN` | `25` | Cap each run so a bug cannot drain the Stripe balance. |
| `REFILL_SOURCE_CHAIN_ID` | `8453` (Base) | Chain Stripe pays USDC on and Squid swaps from. |
| `send` / `--send` | off | Dry-run unless this is set. |

## How to turn it on

1. Set the GitHub secrets listed above (never commit them; never add them as Wrangler plaintext).
2. Run **refill-usdfc** with `send=false` and confirm the plan in the job summary: balances, payout size, missing secrets, Squid quote if the integrator id is set.
3. Fund the Stripe financial account and the sponsor's Base (or Ethereum) gas.
4. Only then run **refill-usdfc** with `send=true`.
