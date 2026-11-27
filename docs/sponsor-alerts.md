# Sponsor low-balance alerts

The sponsor Worker cron (`*/10`, both Calibration and mainnet) reads the sponsor's FIL and USDFC and each ready spare's Filecoin Pay runway. If any of those fall below a threshold, it emails Andy (`snadrus@gmail.com`): once when the wallet goes low, once when it recovers, and a daily reminder while it stays low. State lives in the Durable Object, so a redeploy does not resend the "went low" mail.

Defaults:

| Check | Warn | Critical |
| --- | --- | --- |
| FIL | `< 0.1` | `< 0.06` (just above the 0.05 FIL gas floor) |
| USDFC | enough for 2 spares at 3-month runway plus 3 minimum first purchases (about 9 USDFC with current pricing) | 1 spare + 1 first purchase (about 4 USDFC) |
| Spare runway | `< 45` days | `< 7` days |

Override with `SPONSOR_ALERT_FIL_WARN_FIL`, `SPONSOR_ALERT_FIL_CRITICAL_FIL`, `SPONSOR_ALERT_USDFC_WARN`, `SPONSOR_ALERT_USDFC_CRITICAL`, `SPONSOR_ALERT_MIN_RUNWAY_DAYS`, `SPONSOR_ALERT_CRITICAL_RUNWAY_DAYS`, `SPONSOR_ALERT_REMINDER_HOURS`. Set `SPONSOR_ALERT_DISABLED=1` to silence sending. `/status` → `alerts` shows the live level, reserve math, last email, and any send error.

Each email includes the network, sponsor address, balances, suggested top-up, and a short how-to (send FIL and USDFC to that address; keep ≥ 0.05 FIL; mainnet auto-refill is in `docs/usdfc-refill.md`).

## Mail path 1 (preferred): Cloudflare Email Routing

The Worker already has a `send_email` binding named `EMAIL` aimed at `snadrus@gmail.com`, from `sponsor@scionbase.ai`. Cloudflare will not actually deliver until the zone and destination are set up. Andy needs to click through this once:

1. Open the Cloudflare dashboard for this account: [dash.cloudflare.com](https://dash.cloudflare.com/) → account that owns **scionbase.ai** (the `fifolders-sponsor` worker, `account_id` `b10ebe4ff9e05d7cca47b48a805b828f`).
2. Select the **scionbase.ai** zone.
3. Go to **Email** → **Email Routing**. If it is off, click **Get started** / **Enable Email Routing** and keep the MX/TXT records Cloudflare adds.
4. Under **Destination addresses**, click **Add** and enter `snadrus@gmail.com`. Cloudflare sends a verification message to that inbox.
5. Open the Gmail message from Cloudflare and click **Verify email address** (or **Confirm**).
6. Under **Custom addresses** (or Routing rules), add `sponsor@scionbase.ai`. It can forward to the verified Gmail or drop the mail — we only need it as the Worker **From** address.
7. Optional, if the dashboard also shows **Email Sending** / **Email Service** (Compute → Email Service → Email Sending): **Onboard Domain** → **scionbase.ai**, accept the DNS records, and wait until the domain shows as ready (usually 5–15 minutes, sometimes up to 24 hours). On the Workers Free plan, mail can only go to verified destination addresses (step 5).

After those clicks, the next cron tick that needs to notify will send via the `EMAIL` binding. `/status` → `alerts.lastChannel` will read `email-routing`. If a deploy of `[[send_email]]` failed before the destination was verified, rerun the **sponsor-worker** workflow after step 5.

## Mail path 2 (fallback): Resend

If Email Routing is not ready, set a Worker secret:

1. Create a [Resend](https://resend.com) API key (the key is only stored as a secret; do not put it in the repo or logs).
2. Add it as the GitHub Actions secret `RESEND_API_KEY`. The sponsor-worker deploy uploads non-empty secrets with `wrangler secret bulk`. Or run `npx wrangler secret put RESEND_API_KEY` in `apps/fifolders/sponsor` against this Cloudflare account.
3. Until a domain is verified on Resend, mail is sent from `onboarding@resend.dev`. After verifying `scionbase.ai` on Resend, set the Worker var or secret `RESEND_FROM=sponsor@scionbase.ai`.

`/status` → `alerts.lastChannel` will read `resend`. The Worker tries Email Routing first and only uses Resend when the `EMAIL` binding is missing.

## Calibration test (forced threshold)

To prove a send without draining the wallet, temporarily set `SPONSOR_ALERT_FIL_WARN_FIL` above the current Calibration FIL balance (for example `"200"`), deploy, wait for the `*/10` cron, confirm the mail and `/status` → `alerts` (`level: "warn"`, `lastAction: "low"`), then restore `"0.1"` and deploy again. The next tick should send the recovery mail.
