import {
  CALIBRATION_REGISTRY_V1,
  CALIBRATION_REGISTRY_V1_FROM_BLOCK,
  MAINNET_REGISTRY_V2,
  MAINNET_REGISTRY_V2_FROM_BLOCK,
} from "fil-folders";
import { getAddress, type Address } from "viem";
import { readEnv } from "./env.js";

export type ChainChoice = "calibration" | "mainnet";

export const NETWORK_KEY = "fifolders:network";
export const DEFAULT_VOLUME = "My Drive";
export const CALIBRATION_RPC = "https://api.calibration.node.glif.io/rpc/v1";
export const MAINNET_RPC = "https://api.node.glif.io/rpc/v1";
export const CHAIN_IDS: Record<ChainChoice, number> = { calibration: 314159, mainnet: 314 };

export function readNetworkPreference(): ChainChoice {
  try {
    const saved = localStorage.getItem(NETWORK_KEY);
    return saved === "mainnet" || saved === "calibration" ? saved : "calibration";
  } catch {
    return "calibration";
  }
}

export function saveNetworkPreference(chain: ChainChoice): void {
  try {
    localStorage.setItem(NETWORK_KEY, chain);
  } catch {
    // The selected network still works for this page when storage is unavailable.
  }
}

export function rpcOf(chain: ChainChoice): string {
  return chain === "mainnet" ? MAINNET_RPC : CALIBRATION_RPC;
}

export function chainIdOf(chain: ChainChoice): number {
  return CHAIN_IDS[chain];
}

export function chainOf(chain: ChainChoice): ChainChoice {
  return chain;
}

/** Networks with a sponsor (VITE_SPONSOR_NETWORKS, comma-separated; default "calibration"). */
export function sponsorNetworks(): ChainChoice[] {
  const raw = readEnv("VITE_SPONSOR_NETWORKS") || "calibration";
  return raw.split(",").map((value) => value.trim()).filter((value): value is ChainChoice => value === "calibration" || value === "mainnet");
}

export function sponsorUrl(chain: ChainChoice = readNetworkPreference()): string {
  const base = readEnv("VITE_SPONSOR_URL").replace(/\/+$/, "");
  if (!base || !sponsorNetworks().includes(chain)) return "";
  return chain === "mainnet" ? `${base}/mainnet` : base;
}

/** Stripe publishable key for a network: test (pk_test_) on Calibration, live (pk_live_) on mainnet. */
export function stripePublishableKey(chain: ChainChoice): string {
  return chain === "mainnet" ? readEnv("VITE_STRIPE_PUBLISHABLE_KEY_MAINNET") : readEnv("VITE_STRIPE_PUBLISHABLE_KEY");
}

export function isSponsored(chain: ChainChoice = readNetworkPreference()): boolean {
  return sponsorUrl(chain) !== "";
}

export const SPONSORED_DEPOSIT_NOTE = "Pay by card. Credits pay only for storage; no FIL or USDFC needed. First purchase includes a one-time $1.50 account setup (minimum $3.91; top-ups from $2.37).";
export const SPONSORED_DATASET_NOTE = "Created once for you and paid from your FiFolders credits.";

export interface SponsorPricing {
  minFirstUsd: number;
  minTopUpUsd: number;
  maxUsd: number;
  suggestedUsd?: number;
  minCreditUsd?: number;
  minNetUsd?: number;
  setupFeeUsd: number;
  reserveUsd: number;
  testMode: boolean;
}

/**
 * Fallback limits, mirroring the sponsor's defaults: charge − Stripe fee (2.9% + 30¢) must
 * reach $2.00 ($1.00 reserve + at least 1 USDFC credit), plus the $1.50 creation fee on a first purchase.
 */
export const DEFAULT_SPONSOR_LIMITS = { minFirstUsd: 3.91, minTopUpUsd: 2.37, maxUsd: 200, suggestedUsd: 10 } as const;

export function sponsoredCreditUsd(fromSponsor?: number): number {
  return Number(readEnv("VITE_SPONSOR_CREDIT_USD") || fromSponsor || 10) || 10;
}

export function sponsoredPurchaseUsd(
  limits: Pick<SponsorPricing, "minFirstUsd" | "minTopUpUsd" | "maxUsd" | "suggestedUsd">,
  first: boolean,
  requested = sponsoredCreditUsd(limits.suggestedUsd),
): number {
  const min = first ? limits.minFirstUsd : limits.minTopUpUsd;
  const usd = Number.isFinite(requested) ? Math.round(requested * 100) / 100 : min;
  return Math.min(limits.maxUsd, Math.max(min, usd));
}

/** Calibration must use Stripe test mode (pk_test_); mainnet live mode. Empty is allowed (sponsor decides). */
export function stripeModeNote(chain: ChainChoice): string | null {
  const key = stripePublishableKey(chain);
  if (!key) return null;
  if (chain === "calibration" && !key.startsWith("pk_test_")) throw new Error("Calibration needs a Stripe test publishable key (pk_test_…).");
  if (chain === "mainnet" && !key.startsWith("pk_live_")) throw new Error("Mainnet needs a Stripe live publishable key (pk_live_…).");
  return chain === "calibration" ? "Test mode: pay with card 4242 4242 4242 4242, any future date, any CVC." : null;
}

/** FolderRegistry the drive uses: env override, else published v1 Calibration (migrates to v2) / v2 mainnet. */
export function registryConfig(chain: ChainChoice): { address: Address; fromBlock: bigint } {
  if (chain === "mainnet") {
    const address = readEnv("VITE_FOLDER_REGISTRY_MAINNET") || MAINNET_REGISTRY_V2;
    const from = readEnv("VITE_REGISTRY_FROM_BLOCK_MAINNET");
    return { address: getAddress(address), fromBlock: from ? BigInt(from) : MAINNET_REGISTRY_V2_FROM_BLOCK };
  }
  const address = getAddress(readEnv("VITE_FOLDER_REGISTRY") || CALIBRATION_REGISTRY_V1);
  const from = readEnv("VITE_REGISTRY_FROM_BLOCK");
  if (from) return { address, fromBlock: BigInt(from) };
  if (address.toLowerCase() === CALIBRATION_REGISTRY_V1.toLowerCase()) {
    return { address, fromBlock: CALIBRATION_REGISTRY_V1_FROM_BLOCK };
  }
  throw new Error("Set VITE_REGISTRY_FROM_BLOCK to the deployment block of VITE_FOLDER_REGISTRY.");
}

export interface SponsorChainConfig {
  network: ChainChoice;
  chainId: number;
  factory: Address;
  legacyFactory: Address | null;
  beacon: Address | null;
  implementation: Address | null;
  registry: Address | null;
  allowlist: { pay: Address; fwss: Address; token: Address };
}

/** Hard-coded fallbacks when /config is unreachable. Updated when a v2 factory is deployed. */
export const FALLBACK_SPONSOR_CONFIG: Record<ChainChoice, Omit<SponsorChainConfig, "network">> = {
  calibration: {
    chainId: 314159,
    factory: "0xCBb99E41C173B06D15212A135ba9F46AAB19DEE5",
    legacyFactory: null,
    beacon: null,
    implementation: null,
    registry: "0x9C06335D7DE588Caa104ee4FC3bb7cd8Aba62443",
    allowlist: {
      pay: "0x09a0fDc2723fAd1A7b8e3e00eE5DF73841df55a0",
      fwss: "0x02925630df557F957f70E112bA06e50965417CA0",
      token: "0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0",
    },
  },
  mainnet: {
    chainId: 314,
    factory: "0xaaA1795A150BA01F7A5894A3D1A95334B695F067",
    legacyFactory: null,
    beacon: null,
    implementation: null,
    registry: "0x0ADf3E4fc709EAC4973Ca5D17FCfEB10eB7b01EB",
    allowlist: {
      pay: "0x23b1e018F08BB982348b15a86ee926eEBf7F4DAa",
      fwss: "0x8408502033C418E1bbC97cE9ac48E5528F371A9f",
      token: "0x80B98d3aa09ffff255c3ba4A241111Ff1262F045",
    },
  },
};

const configCache = new Map<ChainChoice, SponsorChainConfig>();

/** Fetch factory, beacon, registry and payment allowlist from the sponsor; fall back to hard-coded values. */
export async function fetchSponsorConfig(chain: ChainChoice = readNetworkPreference()): Promise<SponsorChainConfig> {
  const cached = configCache.get(chain);
  if (cached) return cached;
  const fallback: SponsorChainConfig = { network: chain, ...FALLBACK_SPONSOR_CONFIG[chain] };
  try {
    const { sponsorCall } = await import("./http.js");
    const remote = await sponsorCall<Partial<SponsorChainConfig>>("/config", undefined, chain);
    if (remote.factory) {
      const next: SponsorChainConfig = {
        network: chain,
        chainId: remote.chainId ?? fallback.chainId,
        factory: remote.factory,
        legacyFactory: remote.legacyFactory ?? fallback.legacyFactory,
        beacon: remote.beacon ?? fallback.beacon,
        implementation: remote.implementation ?? fallback.implementation,
        registry: remote.registry ?? fallback.registry,
        allowlist: { ...fallback.allowlist, ...remote.allowlist },
      };
      configCache.set(chain, next);
      return next;
    }
  } catch {
    // Sponsor unreachable or old Worker without /config: use the compiled fallback.
  }
  configCache.set(chain, fallback);
  return fallback;
}
