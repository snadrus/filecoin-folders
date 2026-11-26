// Gasless UI: passkey-first sign-in, USDFC credit balance, and the card ("Add credits") entry points.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp, type ViewModel } from "../src/view.js";
import { DEFAULT_SPONSOR_LIMITS, SPONSORED_DEPOSIT_NOTE, sponsoredPurchaseUsd } from "../src/sponsored.js";
import { PASSKEY_EXISTING, PASSKEY_NEW, PASSKEY_RDNS } from "../src/live-onboarding.js";
import { recoverPasskeyCandidates } from "../src/passkey.js";
import { p256 } from "@noble/curves/p256";
import { hexToBytes, sha256 } from "viem";
import { DEFAULT_PRICING } from "../sponsor/pricing.js";

function model(over: Partial<ViewModel>): ViewModel {
  return {
    connected: false,
    costsOpen: false,
    costs: { depositNote: SPONSORED_DEPOSIT_NOTE, datasetNote: "" },
    chainSteps: [],
    activity: [],
    activityPending: false,
    runway: { headline: "", detail: "", low: false, showAdd: false, datasetLabel: "" },
    loose: [],
    looseSummary: "",
    txlogOpen: false,
    badges: {},
    chain: "calibration",
    mainnetBlocked: false,
    volumeName: "My files",
    encrypt: false,
    encrypted: false,
    owner: "",
    nav: "drive",
    cwdLabel: "",
    crumbs: [],
    query: "",
    entries: [],
    selected: [],
    stars: new Set(),
    storageUsed: 0,
    newMenu: false,
    accountMenu: false,
    context: null,
    dialog: null,
    details: null,
    downloads: { active: null, pending: [], error: null, finished: [] },
    preview: null,
    uploads: [],
    toasts: [],
    walletPrompts: [],
    setupNote: "",
    setupStep: null,
    dropPath: null,
    dragging: false,
    felarumiUrl: "",
    felanumioUrl: "",
    connectError: "",
    wallets: [],
    walletRdns: "",
    panel: null,
    setupError: "",
    stagedCount: 0,
    ...over,
  } as unknown as ViewModel;
}

const panel = (paymentsReady: boolean) => ({
  address: "0x00000000000000000000000000000000000000aa",
  fil: "0",
  usdfc: "0",
  deposit: paymentsReady ? "4.85" : "0",
  availableFunds: "",
  lockupRate: "0",
  paymentsReady,
  sessionReady: false,
  sessionExpiry: "",
  datasets: [],
  selectedDatasetId: "",
  createPrimary: false,
  legacyRegistry: false,
  signatures: 0,
  connectPrompts: 0,
});

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("gasless UI (sponsor configured)", () => {
  beforeEach(() => vi.stubEnv("VITE_SPONSOR_URL", "https://sponsor.example"));
  afterEach(() => vi.unstubAllEnvs());

  it("sign-in: create or reuse a passkey by default; wallets under a collapsed Advanced section", () => {
    const choices = [
      { rdns: PASSKEY_NEW, name: "Create a passkey" },
      { rdns: PASSKEY_EXISTING, name: "Use an existing passkey" },
      { rdns: "io.metamask", name: "MetaMask" },
    ];
    const root = mount(renderApp(model({ wallets: choices, walletRdns: PASSKEY_NEW })));
    const create = root.querySelector<HTMLButtonElement>("[data-testid=passkey-new]")!;
    expect(create.className).toBe("primary");
    expect([create.name, create.value, create.type]).toEqual(["wallet", PASSKEY_NEW, "submit"]);
    expect(root.querySelector<HTMLButtonElement>("[data-testid=passkey-existing]")!.value).toBe(PASSKEY_EXISTING);
    expect(root.querySelector("[data-testid=passkey-continue]")).toBeNull();
    const advanced = root.querySelector<HTMLDetailsElement>("[data-testid=advanced]")!;
    expect(advanced.open).toBe(false);
    expect(advanced.querySelector("summary")!.textContent).toContain("Advanced");
    expect([...advanced.querySelectorAll<HTMLOptionElement>("[data-testid=wallet-pick] option")].map((o) => o.value)).toEqual(["io.metamask"]);
    expect(advanced.querySelector("[data-testid=connect-wallet]")).toBeTruthy();
    expect(advanced.querySelector("[data-testid=encrypt]")).toBeTruthy();
  });

  it("sign-in: a passkey saved on this device is the one-tap default", () => {
    const root = mount(renderApp(model({ wallets: [{ rdns: PASSKEY_RDNS, name: "Continue with your passkey" }, { rdns: PASSKEY_NEW, name: "" }, { rdns: PASSKEY_EXISTING, name: "" }], walletRdns: PASSKEY_RDNS })));
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-testid=passkey-signin] button")];
    expect(buttons.map((b) => b.dataset.testid)).toEqual(["passkey-continue", "passkey-new", "passkey-existing"]);
    expect(buttons[0]!.className).toBe("primary");
    expect(buttons[1]!.className).toBe("");
  });

  it("no credits yet: 'Buy storage credits' opens checkout, note states the minimums", () => {
    const root = mount(renderApp(model({ panel: panel(false) as never })));
    const buy = root.querySelector<HTMLButtonElement>("[data-testid=fix-payments]")!;
    expect(buy.textContent).toBe("Buy storage credits");
    expect(buy.dataset.action).toBe("fix-payments");
    expect(root.querySelector("[data-testid=credit-balance]")).toBeNull();
    expect(root.textContent).toContain("minimum $3.91; top-ups from $2.37");
  });

  it("funded: shows the available USDFC and an 'Add credits' button", () => {
    const root = mount(renderApp(model({ panel: panel(true) as never })));
    expect(root.querySelector("[data-testid=credit-balance]")!.textContent).toBe("Storage credits: 4.85 USDFC available");
    const add = root.querySelector<HTMLButtonElement>("[data-testid=add-credits]")!;
    expect(add.textContent).toBe("Add credits");
    expect(add.dataset.action).toBe("add-funds");
  });
});

describe("card amount", () => {
  it("suggests $10, raised to the minimum and capped at $200", () => {
    expect(sponsoredPurchaseUsd(DEFAULT_SPONSOR_LIMITS, true)).toBe(10);
    expect(sponsoredPurchaseUsd(DEFAULT_SPONSOR_LIMITS, false)).toBe(10);
    expect(sponsoredPurchaseUsd({ ...DEFAULT_SPONSOR_LIMITS, suggestedUsd: 20 }, true)).toBe(20); // sponsor's /pricing suggestion
    expect(sponsoredPurchaseUsd(DEFAULT_SPONSOR_LIMITS, true, 2)).toBe(3.91);
    expect(sponsoredPurchaseUsd(DEFAULT_SPONSOR_LIMITS, false, 1)).toBe(2.37);
    expect(sponsoredPurchaseUsd(DEFAULT_SPONSOR_LIMITS, false, 500)).toBe(200);
  });
  it("client fallback minimums match the sponsor's", () => {
    expect(DEFAULT_SPONSOR_LIMITS).toEqual({ minFirstUsd: DEFAULT_PRICING.minFirstCents / 100, minTopUpUsd: DEFAULT_PRICING.minTopUpCents / 100, maxUsd: DEFAULT_PRICING.maxCents / 100, suggestedUsd: DEFAULT_PRICING.suggestedCents / 100 });
  });
});

describe("existing passkey on a new device", () => {
  it("recovers the passkey public key from a signature (one of two candidates)", () => {
    const priv = p256.utils.randomPrivateKey();
    const pub = p256.getPublicKey(priv, false);
    const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
    const message = hexToBytes(sha256(new TextEncoder().encode("authenticatorData || sha256(clientDataJSON)")));
    const sig = p256.sign(message, priv, { prehash: false, lowS: true });
    const candidates = recoverPasskeyCandidates(message, sig.r, sig.s);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates).toContainEqual({ x: hex(pub.slice(1, 33)), y: hex(pub.slice(33)) });
  });
});
