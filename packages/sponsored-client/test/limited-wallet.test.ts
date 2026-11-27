import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectLimitedWallet,
  isLimitedWalletMessage,
  isSafariLike,
  limitedWalletOrigin,
  LIMITED_WALLET_CHANNEL,
  LIMITED_WALLET_IFRAME_ALLOW,
  LIMITED_WALLET_PROTOCOL,
  normalizeWalletUrl,
  shouldPreferPopup,
  type LimitedWalletMessage,
} from "../src/limited-wallet.js";
import { describeLimitedWalletAction, webauthnPolicyAllows } from "../src/wallet-frame.js";

describe("protocol helpers", () => {
  it("normalizes the wallet URL and origin", () => {
    expect(normalizeWalletUrl("https://fifolders.scionbase.ai/wallet")).toBe("https://fifolders.scionbase.ai/wallet/");
    expect(limitedWalletOrigin("https://fifolders.scionbase.ai/wallet/")).toBe("https://fifolders.scionbase.ai");
    expect(limitedWalletOrigin("http://127.0.0.1:4177/wallet/")).toBe("http://127.0.0.1:4177");
  });

  it("accepts only same-channel, versioned messages", () => {
    expect(isLimitedWalletMessage({ channel: LIMITED_WALLET_CHANNEL, v: LIMITED_WALLET_PROTOCOL, kind: "ready" })).toBe(true);
    expect(isLimitedWalletMessage({ channel: "other", v: 1, kind: "ready" })).toBe(false);
    expect(isLimitedWalletMessage({ channel: LIMITED_WALLET_CHANNEL, v: 99, kind: "ready" })).toBe(false);
    expect(isLimitedWalletMessage(null)).toBe(false);
    expect(isLimitedWalletMessage("ready")).toBe(false);
  });

  it("prefers a popup for Safari passkey creation, not for get or for Chrome", () => {
    const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    const iosChrome = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1";
    const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
    const firefox = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:132.0) Gecko/20100101 Firefox/132.0";
    expect(isSafariLike(safari)).toBe(true);
    expect(isSafariLike(iosChrome)).toBe(true);
    expect(isSafariLike(chrome)).toBe(false);
    expect(isSafariLike(android)).toBe(false);
    expect(isSafariLike(firefox)).toBe(false);
    expect(shouldPreferPopup("create", safari)).toBe(true);
    expect(shouldPreferPopup("assert", safari)).toBe(false);
    expect(shouldPreferPopup("create", chrome)).toBe(false);
    expect(shouldPreferPopup("create", android)).toBe(false);
  });

  it("describes the action shown on the wallet page", () => {
    const base = { channel: LIMITED_WALLET_CHANNEL, v: LIMITED_WALLET_PROTOCOL, kind: "request" as const, requestId: "1", clientOrigin: "https://dapp.example" };
    expect(describeLimitedWalletAction({ ...base, method: "create", params: { name: "Ada" } })).toContain("create a passkey");
    expect(describeLimitedWalletAction({ ...base, method: "assert", params: { credentialId: "x", challenge: "0xab" } })).toContain("sign a request");
    expect(describeLimitedWalletAction({ ...base, method: "assert", params: { credentialId: "x", challenge: "0xab", action: "add a session key" } })).toContain("add a session key");
    expect(describeLimitedWalletAction({ ...base, method: "discover", params: { challenge: "0xab" } })).toContain("existing");
  });

  it("allows WebAuthn in a top-level wallet page", () => {
    expect(webauthnPolicyAllows("create")).toBe(true);
    expect(webauthnPolicyAllows("assert")).toBe(true);
  });
});

describe("connectLimitedWallet handshake", () => {
  const walletUrl = "http://127.0.0.1:9/wallet/";
  const walletOrigin = "http://127.0.0.1:9";

  it("accepts a result only from the wallet origin and matching request id", async () => {
    const client = connectLimitedWallet({ walletUrl, timeoutMs: 2_000 });
    const posts: { origin: string; data: unknown }[] = [];
    const pending = (async () => {
      await Promise.resolve();
      const iframe = document.querySelector<HTMLIFrameElement>("[data-testid=limited-wallet-iframe]")!;
      const content = iframe.contentWindow!;
      const original = content.postMessage.bind(content);
      content.postMessage = ((data: unknown, origin: string) => {
        posts.push({ origin, data });
        original(data, origin);
      }) as typeof content.postMessage;
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { channel: LIMITED_WALLET_CHANNEL, v: LIMITED_WALLET_PROTOCOL, kind: "ready" },
          origin: walletOrigin,
          source: content,
        }),
      );
      await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
      const request = posts[0]!.data as { requestId: string; method: string; clientOrigin: string };
      expect(posts[0]!.origin).toBe(walletOrigin);
      expect(request.method).toBe("create");
      expect(request.clientOrigin).toBe(window.location.origin);

      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            channel: LIMITED_WALLET_CHANNEL,
            v: LIMITED_WALLET_PROTOCOL,
            kind: "result",
            requestId: request.requestId,
            ok: true,
            method: "create",
            result: { credentialId: "from-evil", x: `0x${"00".repeat(32)}`, y: `0x${"00".repeat(32)}` },
          },
          origin: "https://evil.example",
          source: content,
        }),
      );

      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            channel: LIMITED_WALLET_CHANNEL,
            v: LIMITED_WALLET_PROTOCOL,
            kind: "result",
            requestId: "not-the-id",
            ok: true,
            method: "create",
            result: { credentialId: "wrong-id", x: `0x${"00".repeat(32)}`, y: `0x${"00".repeat(32)}` },
          },
          origin: walletOrigin,
          source: content,
        }),
      );

      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            channel: LIMITED_WALLET_CHANNEL,
            v: LIMITED_WALLET_PROTOCOL,
            kind: "result",
            requestId: request.requestId,
            ok: true,
            method: "create",
            result: { credentialId: "ok", x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}` },
          },
          origin: walletOrigin,
          source: content,
        }),
      );
    })();

    const [key] = await Promise.all([client.create("Ada"), pending]);
    expect(key.credentialId).toBe("ok");
    client.close();
  });

  it("falls back toward a popup when the iframe reports it cannot run passkeys", async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("open", open);
    const client = connectLimitedWallet({ walletUrl, timeoutMs: 500, preferPopup: false });
    const work = (async () => {
      await Promise.resolve();
      const iframe = document.querySelector<HTMLIFrameElement>("[data-testid=limited-wallet-iframe]")!;
      const content = iframe.contentWindow!;
      const posts: unknown[] = [];
      const original = content.postMessage.bind(content);
      content.postMessage = ((data: unknown, origin: string) => {
        posts.push(data);
        original(data, origin);
      }) as typeof content.postMessage;
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { channel: LIMITED_WALLET_CHANNEL, v: LIMITED_WALLET_PROTOCOL, kind: "ready" },
          origin: walletOrigin,
          source: content,
        }),
      );
      await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
      const request = posts[0] as { requestId: string };
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            channel: LIMITED_WALLET_CHANNEL,
            v: LIMITED_WALLET_PROTOCOL,
            kind: "result",
            requestId: request.requestId,
            ok: false,
            code: "need-popup",
            error: "iframe cannot use passkeys",
          },
          origin: walletOrigin,
          source: content,
        }),
      );
    })();

    await expect(Promise.all([client.create("Ada"), work])).rejects.toThrow(/blocked the wallet popup/i);
    expect(open).toHaveBeenCalled();
    client.close();
    vi.unstubAllGlobals();
  });
});

