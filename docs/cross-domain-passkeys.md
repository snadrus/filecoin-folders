# Cross-domain passkeys for the limited wallet

The limited-wallet client lives in `@fifolders/sponsored-client` (there is no separate `limited_wallet` package). Passkeys own a `LockedSignerAccount`. They must work from any dApp origin, not only `fifolders.scionbase.ai`.

Re-enrollment is expected: there are no production users yet, and earlier passkeys were created without an `rp.id`, so the browser bound them to the exact hostname (`fifolders.scionbase.ai`).

## Binding behavior

`packages/sponsored-client/src/passkey.ts` now sets `rp.id` to `scionbase.ai` whenever the page itself is on `scionbase.ai` or a subdomain. That is a valid RP ID for `fifolders.scionbase.ai`, `wallet.scionbase.ai`, and any future scionbase.ai host. Localhost and other dev hosts omit `rp.id` (using `scionbase.ai` there would throw a `SecurityError`).

The sponsor (`apps/fifolders/sponsor/auth.ts`) and `LockedSignerAccount` still check only the WebAuthn type, the challenge, the user-present flag, and the P-256 signature. They do not check `origin` or `rpIdHash`. A signature produced on any origin would verify on chain. The browser, not the contract, is what stops a foreign page from minting that signature: it will only offer a passkey whose RP ID matches the current document.

Because the chain is not origin-bound, the wallet page always shows the requesting dApp origin and the action, and waits for an explicit Continue before `navigator.credentials.create` / `get`.

Discoverable credentials (`residentKey: "required"`) are required. Third-party iframe storage is partitioned by top-level site, so the wallet page cannot rely on `localStorage` to remember a credential id across dApps. A discoverable passkey is offered by the authenticator from the RP ID alone.

## Can a client library use an iframe, or do we need a popup?

**Both.** An iframe can run the ceremony on some browsers when the embedder delegates Permissions Policy. A popup is required as a fallback, and is the only reliable path for Safari and for many in-app webviews.

### What the iframe needs

1. The embedder's `<iframe allow="publickey-credentials-get *; publickey-credentials-create *">`. `connectLimitedWallet` sets this (`LIMITED_WALLET_IFRAME_ALLOW`).
2. If the embedder also sends a `Permissions-Policy` header, that header must list the wallet origin. A header of `self` only will block the iframe even with `allow`. The connector then falls back to a popup.
3. Cross-origin `create()` also needs [transient user activation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API). The wallet page's Continue button supplies that gesture.
4. The wallet document itself must be a secure context (HTTPS, or localhost).

### Browser matrix (late 2026)

| Browser | `get()` in a cross-origin iframe | `create()` in a cross-origin iframe | Notes |
| --- | --- | --- | --- |
| Chrome / Edge desktop | Yes, with `allow` (Chrome 84+ / policy 88+) | Yes, with `allow` + user activation ([Chrome 123](https://developer.chrome.com/blog/chrome-123-beta), March 2024) | Confirmed empirically in Playwright Chromium; see below. |
| Chrome Android | Yes, with `allow` | Yes, with `allow` + user activation (Chrome 123+) | Same engine as desktop Chrome. |
| Firefox desktop / Android | Yes, with `allow` (118+) | Yes, with `allow` + user activation (123+) | [caniuse](https://caniuse.com/mdn-html_elements_iframe_allow_publickey-credentials-create) agrees. |
| Safari macOS / iOS | No / unreliable | No | WebKit does not implement credential *creation* in a cross-origin iframe ([standards-positions #304](https://github.com/WebKit/standards-positions/issues/304)). caniuse still reports no support for the `allow` token on `get` either, including current Safari 27. Use a popup. Chrome/Firefox on iOS are WebKit and inherit this. |
| Android / iOS in-app webviews | Often no | Often no | Many WKWebView and Android WebView shells, and social in-app browsers, break WebAuthn or third-party frames. A popup or a handoff to the system browser may still fail. Treat this as best-effort. |

A Playwright Chromium test in this repo (`apps/fifolders/e2e-wallet/cross-origin-passkey.spec.ts`) creates two distinct origins (`localhost:4177` and `localhost:4178` (two ports, so two origins; IP addresses are not valid WebAuthn RP IDs)) and a CDP virtual authenticator:

- **With** `allow="publickey-credentials-get *; publickey-credentials-create *"`: both `create()` and `get()` succeed.
- **Without** the `allow` attribute: both reject with `NotAllowedError` / a Permissions Policy error.

Safari, Firefox, and real-phone webviews are not exercised in that job; the table above is from current platform docs and caniuse, not from that run.

### Popup fallback

`window.open` on the wallet origin is a top-level document, so WebAuthn works in every browser that supports passkeys at all. It must be opened from a user gesture or the popup blocker will reject it.

If we already know the iframe will fail (Safari `create()`, or the caller set `preferPopup`), the connector opens the popup on the original click. If the iframe is tried first and then fails, the original gesture is gone: the connector calls `onPopupBlocked(retry)` so the app can show an "Open wallet window" button, and `retry()` opens the popup from that new click.

### Related Origin Requests

[`/.well-known/webauthn`](https://web.dev/articles/webauthn-related-origin-requests) lets additional *origins you list* use your RP ID *in their own document*, without an iframe. Chrome/Edge 128+, Safari 18+ (macOS 15+ / iOS 18+), and Firefox 152+ (May 2026) support it. It does not scale to arbitrary dApps:

- The RP must list every origin in a file at `https://scionbase.ai/.well-known/webauthn`.
- Clients are only required to honor about five unique labels (the label before the eTLD+1). A public wallet cannot put "every dApp" in that file.
- It is meant for first-party ccTLD / brand-domain sets, not a third-party wallet SDK.
- The apex `scionbase.ai` host would also have to serve that file (DNS and hosting that are not in this deploy).

We do not use Related Origin Requests for third-party dApps. First-party `*.scionbase.ai` already shares the RP ID by the ordinary suffix rule, so we do not need the well-known file for those hosts either.

## What other wallets chose

- **Coinbase Smart Wallet** (`keys.coinbase.com`): a popup (or QR on mobile). The passkey is bound to `keys.coinbase.com`. The SDK does not run WebAuthn on the dApp origin.
- **Porto**: iframe first, with `publickey-credentials-get/create` on the iframe `allow` attribute, and a popup fallback. Safari credential *creation* goes straight to a popup. HTTP origins and browsers without Intersection Observer v2 (unless the parent is on a trusted-host list) also fall back, as clickjacking defense.
- **Privy**: a hidden iframe at `keys.privy.io` holds key material. Passkey prompts use the native WebAuthn dialog; OAuth still pops a top-level window. Third-party wallet kits that embed Privy default to the iframe and escalate to a popup when the host asks.
- **Turnkey**: `@turnkey/iframe-stamper` for embedded signing in a cross-origin iframe, plus a documented [popup wallet](https://github.com/tkhq/popup-wallet-demo) that returns EIP-1193 results over `postMessage`.

Our connector follows the Porto shape: iframe first, popup when the iframe cannot run the ceremony.

## Library design

```ts
import {
  connectLimitedWallet,
  createPasskey,
  findExistingPasskey,
  passkeyAssert,
  directPasskeyHost,
} from "@fifolders/sponsored-client";

// Third-party dApp (any origin):
const passkeys = connectLimitedWallet({
  walletUrl: "https://fifolders.scionbase.ai/wallet/",
  onPopupBlocked: (retry) => showOpenWalletButton(retry),
});
const key = await passkeys.create("Ada");
const assertion = await passkeys.assert(key.credentialId, digest);
const existing = await findExistingPasskey(lookup, passkeys);

// First-party FiFolders on *.scionbase.ai (or localhost tests):
const key2 = await createPasskey("FiFolders"); // rp.id set automatically when the host allows it
```

`connectLimitedWallet` implements `PasskeyHost`. `signIn` / `ownerSigner` accept `identity.passkeys` so a dApp can thread the connector all the way through session-key authorization. FiFolders itself keeps the direct host: it already runs on a scionbase.ai origin (so `rp.id = scionbase.ai` works in-page), and the Node e2e soft authenticator mocks `navigator.credentials` on the app page.

The postMessage protocol (`limited-wallet`, `v: 1`) is in `packages/sponsored-client/src/limited-wallet.ts`:

- The parent talks only to the wallet origin; the wallet talks only to `event.source` (the parent or opener) and displays `event.origin`, never a spoofable field in the payload.
- Requests carry a random `requestId`. Results with the wrong origin or id are ignored.
- The wallet replies `need-popup` without prompting if Permissions Policy would reject `create` / `get` in the iframe.

The wallet page ships with the existing GitHub Pages deploy at `https://fifolders.scionbase.ai/wallet/` (`apps/fifolders/wallet/`). No new DNS is required for that URL. A later dedicated host such as `wallet.scionbase.ai` can serve the same page without re-enrollment, because the RP ID is already `scionbase.ai`. That hostname needs a Cloudflare DNS record and a route or Pages/Worker target; it is not wired in this change.

## Tests

- Unit: `packages/sponsored-client/test/passkey.test.ts`, `packages/sponsored-client/test/limited-wallet.test.ts` (RP ID selection, origin checks, Safari popup preference, iframe `allow` attribute, need-popup fallback).
- Cross-origin e2e: `pnpm --filter fifolders e2e:wallet` (empirical iframe matrix in Chromium, plus the real connector in iframe and popup modes).

Existing FiFolders unit tests and sponsor e2e keep using the direct `createPasskey` / `passkeyAssert` path.
