import { describe, expect, it } from "vitest";
import { DriveApp } from "../src/drive-app.js";
import { watchWalletPrompts, walletPrompts } from "../src/wallet-prompts.js";

describe("wallet prompt toast", () => {
  it("shows a waiting toast, turns a rejection into Retry, and resolves on retry", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new DriveApp({
      volume: null,
      owner: "",
      chain: "calibration",
      encrypted: false,
      volumeName: "My Drive",
      cas: { takeMerged: () => false },
      felarumiUrl: "./felarumi/",
      felanumioUrl: "./felanumio/",
    });
    app.mount(root);
    let calls = 0;
    let release: (value: unknown) => void = () => undefined;
    const raw = {
      secret: 7,
      request(args: { method: string }) {
        if (args.method === "eth_chainId") return Promise.resolve("0x4cb2f");
        calls += 1;
        if (calls === 1) return Promise.reject(Object.assign(new Error("User rejected the request."), { code: 4001 }));
        return new Promise((resolve) => (release = resolve));
      },
      ping() {
        return this.secret;
      },
    };
    const provider = watchWalletPrompts(raw);
    expect(provider.ping()).toBe(7);
    await expect(provider.request({ method: "eth_chainId" })).resolves.toBe("0x4cb2f");
    expect(walletPrompts()).toHaveLength(0);
    const pending = provider.request({ method: "eth_sendTransaction" });
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelector("[data-testid=wallet-prompt]")?.getAttribute("data-state")).toBe("rejected");
    expect(root.textContent).toContain("Signature rejected");
    root.querySelector<HTMLButtonElement>("[data-testid=wallet-retry]")!.click();
    expect(root.textContent).toContain("Check your wallet — approve the transaction to continue");
    expect(root.querySelector(".spinner")).toBeTruthy();
    release("0xhash");
    await expect(pending).resolves.toBe("0xhash");
    expect(root.querySelector("[data-testid=wallet-prompt]")).toBeNull();

    calls = 0;
    const cancelled = provider.request({ method: "personal_sign" });
    await Promise.resolve();
    await Promise.resolve();
    root.querySelector<HTMLButtonElement>("[data-testid=wallet-cancel]")!.click();
    await expect(cancelled).rejects.toThrow("Signature rejected");
    expect(walletPrompts()).toHaveLength(0);
  });
});
