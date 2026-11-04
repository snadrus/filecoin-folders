import { describe, expect, it } from "vitest";
import { watchWalletPrompts } from "../src/wallet-prompts.js";
import { safeOn } from "../src/eip6963.js";

/** A wallet extension's injected Proxy: frozen target, non-configurable `on`, trap returns a different function. */
function hostile() {
  const target = Object.freeze({
    on(_e: string, _f: unknown) {},
    request: async () => ["0x0000000000000000000000000000000000000001"],
  });
  return new Proxy(target, {
    get(t, key, recv) {
      const v = Reflect.get(t, key, recv);
      return typeof v === "function" ? (...a: unknown[]) => (v as (...x: unknown[]) => unknown)(...a) : v;
    },
  });
}

describe("hostile injected wallet Proxy", () => {
  it("reproduces the non-configurable TypeError on plain access", () => {
    expect(() => hostile().on).toThrow(/non-configurable/);
  });
  it("safeOn never throws", () => {
    // Recovers the real `on` through the property descriptor.
    expect(safeOn(hostile(), "accountsChanged", () => {})).toBe(true);
    const worse = new Proxy(Object.freeze({ on() {} }), {
      get: () => () => {},
      getOwnPropertyDescriptor: () => {
        throw new Error("nope");
      },
    });
    expect(safeOn(worse, "accountsChanged", () => {})).toBe(false);
    expect(safeOn(undefined, "x", () => {})).toBe(false);
  });
  it("watchWalletPrompts over a frozen provider: on() and request() work, nothing throws", async () => {
    const calls: string[] = [];
    const frozen = Object.freeze({
      on(event: string) {
        calls.push(event);
      },
      request: async () => "0x4cb2f",
    });
    const wrapped = watchWalletPrompts(frozen) as unknown as { on: (e: string, f: () => void) => void; request: (a: { method: string }) => Promise<unknown> };
    expect(() => wrapped.on("chainChanged", () => {})).not.toThrow();
    expect(calls).toEqual(["chainChanged"]);
    expect(await wrapped.request({ method: "eth_chainId" })).toBe("0x4cb2f");
    const h = watchWalletPrompts(hostile() as never) as { on?: unknown; request: (a: { method: string }) => Promise<unknown> };
    expect(() => h.on).not.toThrow();
    expect(await h.request({ method: "eth_accounts" })).toHaveLength(1);
  });
});
