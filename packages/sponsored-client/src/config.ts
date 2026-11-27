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
