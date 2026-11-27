/**
 * Runs inside the limited-wallet page. Listens for postMessage requests from a parent iframe or opener
 * popup, shows the requesting origin and the action, then runs the WebAuthn ceremony in this document
 * (RP ID scionbase.ai in production). Signatures are not origin-bound on chain, so the user must see
 * and confirm the caller before we call navigator.credentials.
 */
import {
  isLimitedWalletMessage,
  LIMITED_WALLET_CHANNEL,
  LIMITED_WALLET_PROTOCOL,
  type LimitedWalletErrorCode,
  type LimitedWalletRequest,
  type LimitedWalletResult,
} from "./limited-wallet.js";
import {
  createPasskey,
  discoverablePasskeyAssert,
  passkeyAssert,
  type DiscoverableAssertion,
  type PasskeyAssertion,
  type PasskeyPublicKey,
} from "./passkey.js";
import { hexToBytes, type Hex } from "viem";

const ACTION: Record<LimitedWalletRequest["method"], (params: LimitedWalletRequest["params"]) => string> = {
  create: (params) => `create a passkey${"name" in params && params.name ? ` (“${params.name}”)` : ""}`,
  assert: (params) => ("action" in params && params.action ? params.action : "sign a request with your passkey"),
  discover: () => "use an existing FiFolders passkey",
};

export function webauthnPolicyAllows(method: LimitedWalletRequest["method"]): boolean {
  if (window.top === window) return true;
  const feature = method === "create" ? "publickey-credentials-create" : "publickey-credentials-get";
  const policy = (document as Document & {
    permissionsPolicy?: { allowsFeature(feature: string, origin?: string): boolean };
    featurePolicy?: { allowsFeature(feature: string, origin?: string): boolean };
  }).permissionsPolicy ?? (document as Document & { featurePolicy?: { allowsFeature(feature: string, origin?: string): boolean } }).featurePolicy;
  try {
    if (policy?.allowsFeature(feature)) return true;
    if (policy?.allowsFeature(feature, window.location.origin)) return true;
  } catch {
    /* feature not recognized */
  }
  return false;
}

export function describeLimitedWalletAction(request: LimitedWalletRequest): string {
  return ACTION[request.method](request.params);
}

type FrameHooks = {
  /** Render a confirmation UI. Resolve true to continue, false if the user cancelled. */
  confirm(input: { origin: string; action: string; method: LimitedWalletRequest["method"] }): Promise<boolean>;
  busy?(busy: boolean): void;
  standalone?(): void;
};

function peer(): { window: Window; role: "iframe" | "popup" } | null {
  if (window.opener && window.opener !== window) return { window: window.opener, role: "popup" };
  if (window.parent && window.parent !== window) return { window: window.parent, role: "iframe" };
  return null;
}

function announce(target: Window, origin: string) {
  target.postMessage({ channel: LIMITED_WALLET_CHANNEL, v: LIMITED_WALLET_PROTOCOL, kind: "ready" }, origin);
}

function reply(target: Window, origin: string, result: LimitedWalletResult) {
  target.postMessage(result, origin);
}

function fail(requestId: string, code: LimitedWalletErrorCode, error: string): LimitedWalletResult {
  return { channel: LIMITED_WALLET_CHANNEL, v: LIMITED_WALLET_PROTOCOL, kind: "result", requestId, ok: false, error, code };
}

function ok(requestId: string, method: LimitedWalletRequest["method"], result: PasskeyPublicKey | PasskeyAssertion | DiscoverableAssertion): LimitedWalletResult {
  return { channel: LIMITED_WALLET_CHANNEL, v: LIMITED_WALLET_PROTOCOL, kind: "result", requestId, ok: true, method, result };
}

async function runCeremony(request: LimitedWalletRequest): Promise<PasskeyPublicKey | PasskeyAssertion | DiscoverableAssertion> {
  if (request.method === "create") {
    const params = request.params as { name: string };
    return createPasskey(params.name);
  }
  if (request.method === "assert") {
    const params = request.params as { credentialId: string; challenge: Hex };
    return passkeyAssert(params.credentialId, params.challenge);
  }
  const params = request.params as { challenge: Hex; credentialId?: string };
  return discoverablePasskeyAssert(hexToBytes(params.challenge), params.credentialId);
}

function cancelledError(error: unknown): boolean {
  const name = error && typeof error === "object" && "name" in error ? String((error as DOMException).name) : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "NotAllowedError" || /cancell?ed|not allowed|timed out/i.test(message);
}

/**
 * Start the wallet-page listener. Safe to call once on DOMContentLoaded.
 * `confirm` should put the requesting origin on screen; never trust `request.clientOrigin` over `event.origin`.
 */
export function runLimitedWalletFrame(hooks: FrameHooks): () => void {
  const target = peer();
  if (!target) {
    hooks.standalone?.();
    return () => undefined;
  }

  const onMessage = async (event: MessageEvent) => {
    if (event.source !== target.window || !isLimitedWalletMessage(event.data)) return;
    if (event.data.kind === "hello" || event.data.kind === "ready") {
      announce(target.window, event.origin);
      return;
    }
    if (event.data.kind !== "request") return;
    const request = event.data;
    // The displayed and authorized caller is the message origin, not a field the parent can spoof.
    const origin = event.origin;
    if (!webauthnPolicyAllows(request.method)) {
      reply(target.window, origin, fail(request.requestId, "need-popup", "This iframe is not allowed to use passkeys. Opening a wallet window instead."));
      return;
    }
    const accepted = await hooks.confirm({ origin, action: describeLimitedWalletAction(request), method: request.method });
    if (!accepted) {
      reply(target.window, origin, fail(request.requestId, "cancelled", "You cancelled the request."));
      return;
    }
    hooks.busy?.(true);
    try {
      const result = await runCeremony(request);
      reply(target.window, origin, ok(request.requestId, request.method, result));
    } catch (error) {
      const code: LimitedWalletErrorCode = cancelledError(error) ? "cancelled" : "failed";
      reply(target.window, origin, fail(request.requestId, code, error instanceof Error ? error.message : "The passkey request failed."));
    } finally {
      hooks.busy?.(false);
    }
  };

  window.addEventListener("message", onMessage);
  announce(target.window, "*");
  // Tight origin would be nicer, but we do not know the parent origin until it messages us.
  // ready is not sensitive; the first request still checks event.origin and shows it to the user.
  return () => window.removeEventListener("message", onMessage);
}
