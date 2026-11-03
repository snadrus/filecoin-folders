import { describe, expect, it } from "vitest";
import { DriveApp } from "../src/drive-app.js";
import { loadOps } from "../src/ops.js";
import { INTENTS, promptLabel, sessionIntent, watchWalletPrompts, walletPrompts, withWalletIntent } from "../src/wallet-prompts.js";

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
    expect(root.textContent).toContain("Check your wallet — Send transaction");
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

  it("names each request with purpose and cost", async () => {
    expect(promptLabel("eth_requestAccounts")).toBe("Connect wallet (free)");
    expect(promptLabel("wallet_switchEthereumChain")).toContain("Switch network");
    expect(promptLabel("eth_chainId")).toBeNull();
    await withWalletIntent(INTENTS.approvePayments, async () => {
      expect(promptLabel("eth_sendTransaction")).toBe(
        "Approve storage payments — lets Filecoin Warm Storage charge your USDFC deposit (no cost now; gas ~0.01 FIL)",
      );
      // Network prompts inside a flow keep their own name.
      expect(promptLabel("wallet_switchEthereumChain")).toContain("Switch network");
    });
    await withWalletIntent(sessionIntent(), async () => {
      expect(promptLabel("eth_sendTransaction")).toBe("Authorize session key — lets FiFolders save for 7 days without asking each time (~0.05 FIL)");
    });
    await withWalletIntent(INTENTS.createDataset, async () => {
      expect(promptLabel("eth_signTypedData_v4")).toBe("Create dataset — reserve storage with a provider (reserve $0.50 USDFC)");
    });
    await withWalletIntent(INTENTS.save(1), async () => {
      expect(promptLabel("eth_sendTransaction")).toBe("Save changes — 1 piece (gas ~0.01 FIL)");
    });
    expect(promptLabel("personal_sign")).toBe("Sign message (free)");
  });

  it("shows the named toast and a Transaction-log row while the wallet waits", async () => {
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
    let release: (value: unknown) => void = () => undefined;
    const provider = watchWalletPrompts({ request: (_args: { method: string }) => new Promise((resolve) => (release = resolve)) });
    const pending = withWalletIntent(INTENTS.save(2), () => provider.request({ method: "eth_sendTransaction" }));
    await Promise.resolve();
    expect(root.querySelector("[data-testid=wallet-prompt-title]")?.textContent).toBe("Save changes");
    expect(root.querySelector("[data-testid=wallet-prompt-detail]")?.textContent).toContain("2 pieces (gas ~0.01 FIL)");
    expect(loadOps().some((op) => op.kind === "wallet" && op.label === "Save 2 pieces to My Drive" && op.detail === "Save changes — 2 pieces (gas ~0.01 FIL)")).toBe(true);
    release("0x1");
    await pending;
    expect(loadOps().some((op) => op.kind === "wallet")).toBe(false);
  });
});

describe("transaction log purpose labels", () => {
  it("names the purpose, never 'Send transaction' or gas", async () => {
    const { purposeText, cleanOpLabel, INTENTS } = await import("../src/wallet-prompts.js");
    expect(purposeText(INTENTS.adopt(3))).toBe("Add 3 Filecoin Drive files");
    expect(purposeText({ title: "Send transaction", cost: "gas" })).toBe("Confirm a wallet request");
    expect(cleanOpLabel("Send transaction (gas)")).toBe("Confirm a wallet request");
    expect(cleanOpLabel("Authorize session key — lets FiFolders save for 7 days (~0.05 FIL)")).toBe("Authorize this browser to save");
    for (const label of [purposeText(INTENTS.save(2)), cleanOpLabel("Create dataset (reserve $0.50 USDFC)")]) expect(label).not.toMatch(/gas|Send transaction|\(/);
  });
});
