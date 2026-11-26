// Gasless UI: passkey-first sign-in, USDFC credit balance, and the card ("Add credits") entry points.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp, type ViewModel } from "../src/view.js";
import { DEFAULT_SPONSOR_LIMITS, SPONSORED_DEPOSIT_NOTE, sponsoredPurchaseUsd } from "../src/sponsored.js";
import { PASSKEY_RDNS } from "../src/live-onboarding.js";
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

  it("sign-in screen: passkey is the default choice, wallets second", () => {
    const root = mount(renderApp(model({ wallets: [{ rdns: PASSKEY_RDNS, name: "Passkey (recommended, no wallet needed)" }, { rdns: "io.metamask", name: "MetaMask" }], walletRdns: PASSKEY_RDNS })));
    const pick = root.querySelector<HTMLSelectElement>("[data-testid=wallet-pick]")!;
    expect(pick.closest("label")!.textContent).toContain("Sign in with");
    expect([...pick.options].map((o) => o.value)).toEqual([PASSKEY_RDNS, "io.metamask"]);
    expect(pick.options[0]!.selected).toBe(true);
    expect(pick.options[0]!.textContent).toMatch(/Passkey/);
    expect(root.querySelector("[data-testid=connect-wallet]")!.textContent).toBe("Continue");
  });

  it("no credits yet: 'Buy storage credits' opens checkout, note states the minimums", () => {
    const root = mount(renderApp(model({ panel: panel(false) as never })));
    const buy = root.querySelector<HTMLButtonElement>("[data-testid=fix-payments]")!;
    expect(buy.textContent).toBe("Buy storage credits");
    expect(buy.dataset.action).toBe("fix-payments");
    expect(root.querySelector("[data-testid=credit-balance]")).toBeNull();
    expect(root.textContent).toContain("minimum $3.10");
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
  it("suggests $5, raised to the minimum and capped at $200", () => {
    expect(sponsoredPurchaseUsd(DEFAULT_SPONSOR_LIMITS, true)).toBe(5);
    expect(sponsoredPurchaseUsd(DEFAULT_SPONSOR_LIMITS, true, 2)).toBe(3.1);
    expect(sponsoredPurchaseUsd(DEFAULT_SPONSOR_LIMITS, false, 1)).toBe(1.55);
    expect(sponsoredPurchaseUsd(DEFAULT_SPONSOR_LIMITS, false, 500)).toBe(200);
  });
  it("client fallback minimums match the sponsor's", () => {
    expect(DEFAULT_SPONSOR_LIMITS).toEqual({ minFirstUsd: DEFAULT_PRICING.minFirstCents / 100, minTopUpUsd: DEFAULT_PRICING.minTopUpCents / 100, maxUsd: DEFAULT_PRICING.maxCents / 100 });
  });
});
