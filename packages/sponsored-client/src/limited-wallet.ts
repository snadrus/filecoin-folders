/**
 * Cross-origin connector for the limited wallet's passkey. A third-party dApp cannot run WebAuthn under
 * scionbase.ai itself, so this module opens a wallet page (iframe first, popup if the iframe cannot run
 * the ceremony) and talks to it with a strict postMessage protocol.
 *
 * First-party TreFolders pages on *.scionbase.ai should keep using {@link directPasskeyHost}; the browser
 * will issue and accept passkeys with RP ID scionbase.ai in that document.
 */
import type { Hex } from "viem";
import type { DiscoverableAssertion, PasskeyAssertion, PasskeyHost, PasskeyPublicKey } from "./passkey.js";

export const LIMITED_WALLET_CHANNEL = "limited-wallet" as const;
export const LIMITED_WALLET_PROTOCOL = 1 as const;

/** Production wallet page, shipped with the TreFolders Pages deploy. */
export const DEFAULT_LIMITED_WALLET_URL = "https://fifolders.scionbase.ai/wallet/";

/**
 * Permissions Policy tokens the embedding page must grant the iframe. The connector sets these on the
 * iframe `allow` attribute; a parent `Permissions-Policy` header that omits the wallet origin will still
 * block the iframe (we then fall back to a popup).
 */
export const LIMITED_WALLET_IFRAME_ALLOW =
  "publickey-credentials-get *; publickey-credentials-create *; clipboard-write";

export type LimitedWalletMethod = "create" | "assert" | "discover";
export type LimitedWalletErrorCode = "cancelled" | "need-popup" | "failed";

export type LimitedWalletCreateParams = { name: string };
export type LimitedWalletAssertParams = { credentialId: string; challenge: Hex; action?: string };
export type LimitedWalletDiscoverParams = { challenge: Hex; credentialId?: string };
export type LimitedWalletParams = LimitedWalletCreateParams | LimitedWalletAssertParams | LimitedWalletDiscoverParams;

export type LimitedWalletHello = {
  channel: typeof LIMITED_WALLET_CHANNEL;
  v: typeof LIMITED_WALLET_PROTOCOL;
  kind: "hello";
};

export type LimitedWalletReady = {
  channel: typeof LIMITED_WALLET_CHANNEL;
  v: typeof LIMITED_WALLET_PROTOCOL;
  kind: "ready";
};

export type LimitedWalletRequest = {
  channel: typeof LIMITED_WALLET_CHANNEL;
  v: typeof LIMITED_WALLET_PROTOCOL;
  kind: "request";
  requestId: string;
  method: LimitedWalletMethod;
  /** Informational only. The wallet always displays and trusts `event.origin`, never this field alone. */
  clientOrigin: string;
  params: LimitedWalletParams;
};

export type LimitedWalletResult =
  | {
      channel: typeof LIMITED_WALLET_CHANNEL;
      v: typeof LIMITED_WALLET_PROTOCOL;
      kind: "result";
      requestId: string;
      ok: true;
      method: LimitedWalletMethod;
      result: PasskeyPublicKey | PasskeyAssertion | DiscoverableAssertion;
    }
  | {
      channel: typeof LIMITED_WALLET_CHANNEL;
      v: typeof LIMITED_WALLET_PROTOCOL;
      kind: "result";
      requestId: string;
      ok: false;
      error: string;
      code: LimitedWalletErrorCode;
    };

export type LimitedWalletMessage = LimitedWalletHello | LimitedWalletReady | LimitedWalletRequest | LimitedWalletResult;

export class LimitedWalletError extends Error {
  readonly code: LimitedWalletErrorCode;
  constructor(code: LimitedWalletErrorCode, message: string) {
    super(message);
    this.name = "LimitedWalletError";
    this.code = code;
  }
}

export function isLimitedWalletMessage(data: unknown): data is LimitedWalletMessage {
  if (!data || typeof data !== "object") return false;
  const value = data as Record<string, unknown>;
  return value.channel === LIMITED_WALLET_CHANNEL && value.v === LIMITED_WALLET_PROTOCOL && typeof value.kind === "string";
}

/** Canonical origin of the wallet page (scheme + host + port, no path). */
export function limitedWalletOrigin(walletUrl: string): string {
  return new URL(walletUrl, globalThis.location?.href ?? "https://fifolders.scionbase.ai/").origin;
}

export function normalizeWalletUrl(walletUrl: string): string {
  const url = new URL(walletUrl, globalThis.location?.href ?? "https://fifolders.scionbase.ai/");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export function walletPageUrl(walletUrl: string, role: "iframe" | "popup"): string {
  const url = new URL(normalizeWalletUrl(walletUrl));
  url.searchParams.set("role", role);
  return url.href;
}

/**
 * Safari (macOS and iOS, including Chrome/Firefox on iOS which are WebKit) cannot create passkeys in a
 * cross-origin iframe. Chrome/Edge (including Android) and Firefox can, with the allow attribute and a
 * user gesture. See docs/cross-domain-passkeys.md.
 */
export function isSafariLike(userAgent = globalThis.navigator?.userAgent ?? ""): boolean {
  const ua = userAgent;
  if (/CriOS|FxiOS|EdgiOS/i.test(ua)) return true;
  if (/Android/i.test(ua)) return false;
  return /Safari/i.test(ua) && !/Chrome|Chromium|Android|CriOS|FxiOS|Edg\//i.test(ua);
}

export function shouldPreferPopup(method: LimitedWalletMethod, userAgent?: string): boolean {
  return method === "create" && isSafariLike(userAgent);
}

export type LimitedWalletOptions = {
  /** Wallet page URL. Defaults to {@link DEFAULT_LIMITED_WALLET_URL}. */
  walletUrl?: string;
  /** Skip the iframe and open a popup immediately. */
  preferPopup?: boolean;
  /** How long to wait for a ceremony (confirmation + OS prompt). */
  timeoutMs?: number;
  /**
   * When a popup is needed after the iframe failed, the original user gesture is gone and the browser
   * may block window.open. Called so the app can show a "Open wallet" button; clicking it should call
   * the returned `retry` function (or just retry the same host method).
   */
  onPopupBlocked?: (retry: () => void) => void;
};

export type LimitedWalletClient = PasskeyHost & {
  readonly walletUrl: string;
  readonly walletOrigin: string;
  close(): void;
};

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function challengeHex(challenge: Uint8Array): Hex {
  return `0x${[...challenge].map((b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function isCancelled(error: unknown): boolean {
  return error instanceof LimitedWalletError && error.code === "cancelled";
}

function errorFromResult(result: Extract<LimitedWalletResult, { ok: false }>): LimitedWalletError {
  return new LimitedWalletError(result.code, result.error);
}

type Inflight = {
  requestId: string;
  method: LimitedWalletMethod;
  params: LimitedWalletParams;
  resolve: (value: PasskeyPublicKey | PasskeyAssertion | DiscoverableAssertion) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Connect to the limited-wallet page. Tries a Permissions-Policy-delegated iframe, and falls back to a
 * `window.open` popup when the iframe cannot run WebAuthn (missing allow attribute, Safari create,
 * in-app webview, or a need-popup response from the wallet).
 */
export function connectLimitedWallet(options: LimitedWalletOptions = {}): LimitedWalletClient {
  const walletUrl = normalizeWalletUrl(options.walletUrl ?? DEFAULT_LIMITED_WALLET_URL);
  const walletOrigin = limitedWalletOrigin(walletUrl);
  const timeoutMs = options.timeoutMs ?? 180_000;
  let iframe: HTMLIFrameElement | null = null;
  let popup: Window | null = null;
  let iframeReady: Promise<Window> | null = null;
  const inflight = new Map<string, Inflight>();

  const drop = (id: string) => {
    const item = inflight.get(id);
    if (item) {
      clearTimeout(item.timer);
      inflight.delete(id);
    }
  };

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== walletOrigin || !isLimitedWalletMessage(event.data) || event.data.kind !== "result") return;
    const item = inflight.get(event.data.requestId);
    if (!item) return;
    drop(event.data.requestId);
    if (event.data.ok) item.resolve(event.data.result);
    else item.reject(errorFromResult(event.data));
  };
  globalThis.addEventListener?.("message", onMessage);

  const send = (target: Window, request: LimitedWalletRequest) => {
    target.postMessage(request, walletOrigin);
  };

  const waitFor = (requestId: string, method: LimitedWalletMethod, params: LimitedWalletParams) =>
    new Promise<PasskeyPublicKey | PasskeyAssertion | DiscoverableAssertion>((resolve, reject) => {
      const timer = setTimeout(() => {
        drop(requestId);
        reject(new LimitedWalletError("failed", "The wallet did not respond in time."));
      }, timeoutMs);
      inflight.set(requestId, { requestId, method, params, resolve, reject, timer });
    });

  const requestBody = (method: LimitedWalletMethod, params: LimitedWalletParams): LimitedWalletRequest => ({
    channel: LIMITED_WALLET_CHANNEL,
    v: LIMITED_WALLET_PROTOCOL,
    kind: "request",
    requestId: randomId(),
    method,
    clientOrigin: globalThis.location?.origin ?? "",
    params,
  });

  const ensureIframe = (): Promise<Window> => {
    if (iframe?.contentWindow) return iframeReady ?? Promise.resolve(iframe.contentWindow);
    iframeReady = new Promise<Window>((resolve, reject) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("allow", LIMITED_WALLET_IFRAME_ALLOW);
      frame.setAttribute("title", "TreFolders limited wallet");
      frame.setAttribute("data-testid", "limited-wallet-iframe");
      Object.assign(frame.style, {
        position: "fixed",
        inset: "0",
        width: "100%",
        height: "100%",
        border: "0",
        zIndex: "2147483646",
        background: "transparent",
        colorScheme: "light",
      } as Partial<CSSStyleDeclaration>);
      const fail = setTimeout(() => {
        globalThis.removeEventListener("message", onReady);
        reject(new LimitedWalletError("need-popup", "The wallet iframe did not load."));
      }, 10_000);
      const onReady = (event: MessageEvent) => {
        if (event.origin !== walletOrigin || event.source !== frame.contentWindow) return;
        if (!isLimitedWalletMessage(event.data) || event.data.kind !== "ready") return;
        clearTimeout(fail);
        globalThis.removeEventListener("message", onReady);
        if (!frame.contentWindow) {
          reject(new LimitedWalletError("need-popup", "The wallet iframe closed."));
          return;
        }
        resolve(frame.contentWindow);
      };
      globalThis.addEventListener("message", onReady);
      frame.src = walletPageUrl(walletUrl, "iframe");
      document.documentElement.appendChild(frame);
      iframe = frame;
    });
    return iframeReady;
  };

  const hideIframe = () => {
    if (!iframe) return;
    Object.assign(iframe.style, { pointerEvents: "none", visibility: "hidden", width: "0", height: "0" });
  };
  const showIframe = () => {
    if (!iframe) return;
    Object.assign(iframe.style, { pointerEvents: "auto", visibility: "visible", width: "100%", height: "100%" });
  };

  const viaIframe = async (method: LimitedWalletMethod, params: LimitedWalletParams) => {
    const target = await ensureIframe();
    showIframe();
    const request = requestBody(method, params);
    send(target, request);
    try {
      return await waitFor(request.requestId, method, params);
    } finally {
      hideIframe();
    }
  };

  const openPopup = (): Window => {
    const features = "popup=yes,width=420,height=640,noopener=no,noreferrer=no";
    const opened = window.open(walletPageUrl(walletUrl, "popup"), "fifolders-limited-wallet", features);
    if (!opened) throw new LimitedWalletError("need-popup", "The browser blocked the wallet popup. Click to open it.");
    popup = opened;
    return opened;
  };

  const viaPopup = async (method: LimitedWalletMethod, params: LimitedWalletParams) => {
    const opened = popup && !popup.closed ? popup : openPopup();
    const request = requestBody(method, params);
    const result = new Promise<PasskeyPublicKey | PasskeyAssertion | DiscoverableAssertion>((resolve, reject) => {
      const timer = setTimeout(() => {
        drop(request.requestId);
        globalThis.removeEventListener("message", onReady);
        reject(new LimitedWalletError("failed", "The wallet window did not respond in time."));
      }, timeoutMs);
      inflight.set(request.requestId, {
        requestId: request.requestId,
        method,
        params,
        resolve: (value) => {
          clearTimeout(timer);
          globalThis.removeEventListener("message", onReady);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          globalThis.removeEventListener("message", onReady);
          reject(error);
        },
        timer,
      });
      const onReady = (event: MessageEvent) => {
        if (event.origin !== walletOrigin || event.source !== opened) return;
        if (!isLimitedWalletMessage(event.data) || event.data.kind !== "ready") return;
        globalThis.removeEventListener("message", onReady);
        send(opened, request);
      };
      globalThis.addEventListener("message", onReady);
      // Ask the window to (re-)announce ready, whether it is still loading or already open.
      try {
        opened.postMessage({ channel: LIMITED_WALLET_CHANNEL, v: LIMITED_WALLET_PROTOCOL, kind: "hello" }, walletOrigin);
      } catch {
        /* the popup may still be loading; it will announce ready itself */
      }
    });
    return result;
  };

  const promptForPopup = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!options.onPopupBlocked) {
        reject(new LimitedWalletError("need-popup", "The browser blocked the wallet popup. Click to open it."));
        return;
      }
      let settled = false;
      options.onPopupBlocked(() => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });

  const call = async (method: LimitedWalletMethod, params: LimitedWalletParams) => {
    const preferPopup = options.preferPopup || shouldPreferPopup(method);
    if (!preferPopup) {
      try {
        return await viaIframe(method, params);
      } catch (error) {
        if (isCancelled(error)) throw error;
        // Missing Permissions Policy, Safari, or a dead iframe: use a popup.
      }
    }
    try {
      return await viaPopup(method, params);
    } catch (error) {
      if (isCancelled(error)) throw error;
      if (error instanceof LimitedWalletError && error.code === "need-popup") {
        await promptForPopup();
        return viaPopup(method, params);
      }
      throw error;
    }
  };

  return {
    walletUrl,
    walletOrigin,
    create: (name) => call("create", { name }) as Promise<PasskeyPublicKey>,
    assert: (credentialId, challenge) => call("assert", { credentialId, challenge }) as Promise<PasskeyAssertion>,
    discover: (challenge, credentialId) =>
      call("discover", { challenge: challengeHex(challenge instanceof Uint8Array ? challenge : new Uint8Array(challenge)), credentialId }) as Promise<DiscoverableAssertion>,
    close() {
      globalThis.removeEventListener?.("message", onMessage);
      for (const id of [...inflight.keys()]) {
        const item = inflight.get(id);
        drop(id);
        item?.reject(new LimitedWalletError("cancelled", "The wallet was closed."));
      }
      iframe?.remove();
      iframe = null;
      iframeReady = null;
      if (popup && !popup.closed) popup.close();
      popup = null;
    },
  };
}
