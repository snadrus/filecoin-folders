import { folderCommitPermission } from "fil-folders";
import { DefaultFwssPermissions } from "@filoz/synapse-core/session-key";
import type { Address, Hex } from "viem";

/**
 * A FiFolders volume is one FolderRegistry head:
 * `(wallet, ns = keccak256("fil-folders"), key = keccak256(volumeName))`.
 * The head is a manifest of piece CIDs.
 *
 * A Synapse dataset is where those piece bytes are stored. One selected
 * dataset serves every volume for that wallet on that chain. The registry
 * does not store the dataset id; the browser does, at
 * `fifolders:dataset:<chainId>:<address>`. Creating a dataset writes metadata
 * `{ app: "fifolders", volume: "<name>" }` so the list can show which volume
 * opened it. Switching datasets changes where new uploads go. Downloads are
 * by piece CID, so pieces the provider still serves remain readable.
 */
export const SESSION_ORIGIN = "fifolders";
/** Seven days. Renew extends the same key; it does not mint a new one. */
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;
/** Block a session-key action when any permission expires inside this window. */
export const SESSION_RENEW_MARGIN_SEC = 5 * 60;
/** Show a non-blocking renew prompt when any permission expires inside this window. */
export const SESSION_WARN_SEC = 24 * 60 * 60;
/** Native FIL sent to the session key so later commits pay their own gas. */
export const SESSION_FUND_WEI = 50_000_000_000_000_000n;
/** USDFC deposited when storage payment is not ready. 18 decimals. */
export const PAYMENT_DEPOSIT = 5n * 10n ** 18n;
const SESSION_SKEW_SEC = 60n;

export type SessionGate = "ok" | "soon" | "expired";

/**
 * `expired` when any required permission is missing or inside the safety margin.
 * `soon` when every permission clears the margin but one expires within a day.
 * Callers pass one expiry per required permission (the four FWSS permissions plus folder commit).
 */
export function sessionGateFromExpiries(expiries: readonly bigint[], nowSec: bigint): SessionGate {
  if (expiries.length === 0) return "expired";
  const margin = nowSec + BigInt(SESSION_RENEW_MARGIN_SEC);
  if (expiries.some((expiry) => expiry <= margin)) return "expired";
  const warn = nowSec + BigInt(SESSION_WARN_SEC);
  if (expiries.some((expiry) => expiry <= warn)) return "soon";
  return "ok";
}

/** Thrown by `Synapse.create` when the session key's FWSS permissions are missing or expired. */
export const SESSION_PERMISSION_ERROR =
  "Session key does not have the required permissions. Please login and sync expirations with the session key first.";

export function isSessionPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("Session key does not have the required permissions");
}

/**
 * Wallet signatures, not connect prompts.
 * `loginAndFund` is 1. The payment fix is an ERC-2612 permit plus
 * `depositWithPermitAndApproveOperator`, so 2. A first encrypted volume adds
 * one `signTypedData`, then the signature is reused from localStorage.
 * A returning visit with a live session key is 0.
 */
export const SIGNATURES = {
  sessionLogin: 1,
  paymentFix: 2,
  encryptSign: 1,
  firstTimePaymentsReady: 1,
  firstTimePaymentsMissing: 3,
  returning: 0,
} as const;

export interface StoredSession {
  v: 1;
  chainId: number;
  root: Address;
  privateKey: Hex;
  sessionAddress: Address;
  expiry: string;
}

export interface DatasetRecord {
  id: string;
  provider: string;
  providerId: string;
  pieceCount: string;
  size: string;
  created: string;
  /** Holds a FiFolders manifest (a FolderRegistry commit points at one of its pieces). */
  drive?: boolean;
  /** Volume name for that manifest, when known. */
  driveName?: string;
  /** Dataset metadata source, e.g. "filecoin-drive" for Filecoin Pin's Filecoin Drive. */
  source?: string;
}

export interface WalletPanel {
  address: string;
  fil: string;
  usdfc: string;
  /** Payments-contract deposit, formatted. */
  deposit: string;
  /** Raw atto-USDFC available in Filecoin Pay. Empty before the wallet is connected. */
  availableFunds: string;
  /** Raw atto-USDFC per epoch across the wallet's rails. */
  lockupRate: string;
  ens?: string;
  paymentsReady: boolean;
  sessionReady: boolean;
  sessionExpiry: string;
  datasets: DatasetRecord[];
  selectedDatasetId: string;
  /** True when the only sensible next step is creating a dataset. */
  createPrimary: boolean;
  /** True when no saved preference matched and the newest dataset was picked for the user. */
  autoPicked?: boolean;
  legacyRegistry: boolean;
  signatures: number;
  connectPrompts: number;
}

export function fifoldersPermissions(): Hex[] {
  return [...DefaultFwssPermissions, folderCommitPermission()];
}

export function sessionStorageKey(chainId: number, root: string): string {
  return `fifolders:session:${chainId}:${root.toLowerCase()}`;
}

export function walletStorageKey(): string {
  return "fifolders:wallet";
}

export function datasetStorageKey(chainId: number, root: string): string {
  return `fifolders:dataset:${chainId}:${root.toLowerCase()}`;
}

export function loadSession(chainId: number, root: string): StoredSession | null {
  const raw = localStorage.getItem(sessionStorageKey(chainId, root));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (parsed?.v !== 1 || !parsed.privateKey || !parsed.sessionAddress || !parsed.expiry) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  localStorage.setItem(sessionStorageKey(session.chainId, session.root), JSON.stringify(session));
}

export function clearSession(chainId: number, root: string): void {
  localStorage.removeItem(sessionStorageKey(chainId, root));
}

export function sessionUsable(session: StoredSession | null, nowSec: bigint): boolean {
  if (!session) return false;
  const expiry = BigInt(session.expiry);
  return expiry > nowSec + SESSION_SKEW_SEC;
}

export function loadLastDataset(chainId: number, root: string): string | null {
  return localStorage.getItem(datasetStorageKey(chainId, root));
}

export function saveLastDataset(chainId: number, root: string, id: string): void {
  localStorage.setItem(datasetStorageKey(chainId, root), id);
}

/** Preferred (last picked) dataset, otherwise the newest FiFolders drive, otherwise the newest one, so connect lands straight in a drive. */
export function chooseDataset(datasets: { id: string; drive?: boolean }[], lastUsed: string | null): { selectedId: string | null; auto: boolean } {
  if (lastUsed && datasets.some((dataset) => dataset.id === lastUsed)) {
    return { selectedId: lastUsed, auto: true };
  }
  const drives = datasets.filter((dataset) => dataset.drive && /^\d+$/.test(dataset.id));
  const numeric = datasets.filter((dataset) => /^\d+$/.test(dataset.id));
  const own = numeric.filter((dataset) => (dataset as { source?: string }).source !== "filecoin-drive");
  const settled = drives.length ? drives : own.length ? own : numeric;
  const newest = settled.length
    ? settled.reduce((best, dataset) => (BigInt(dataset.id) > BigInt(best.id) ? dataset : best))
    : datasets[datasets.length - 1];
  return newest ? { selectedId: newest.id, auto: true } : { selectedId: null, auto: false };
}

/** Newest settled (numeric) dataset id, used for the "latest" marker. */
export function latestDatasetId(datasets: { id: string }[]): string {
  const settled = datasets.filter((dataset) => /^\d+$/.test(dataset.id));
  if (!settled.length) return "";
  return settled.reduce((best, dataset) => (BigInt(dataset.id) > BigInt(best.id) ? dataset : best)).id;
}

/** Auto-pick only counts when nothing saved matched one of the wallet's datasets. */
export function wasAutoPicked(datasets: { id: string }[], remembered: string | null, selectedId: string | null): boolean {
  if (!selectedId) return false;
  return !(remembered && datasets.some((dataset) => dataset.id === remembered));
}

export function paymentsReady(deposited: bigint, approved: boolean): boolean {
  return deposited > 0n && approved;
}

export function canEnter(panel: Pick<WalletPanel, "paymentsReady" | "sessionReady" | "selectedDatasetId" | "legacyRegistry">): boolean {
  if (!panel.paymentsReady || !panel.selectedDatasetId) return false;
  // Uploads always sign with the session key, so a legacy registry no longer skips it.
  return panel.sessionReady;
}

export function formatToken(value: bigint, decimals = 18, digits = 4): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  const text = frac ? `${whole.toString()}.${frac}` : whole.toString();
  return negative ? `-${text}` : text;
}

export function formatExpiry(expirySec: bigint): string {
  if (expirySec <= 0n) return "";
  const ms = Number(expirySec) * 1000;
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleString();
}

export function datasetLabel(dataset: DatasetRecord): string {
  const created = dataset.created && dataset.created !== "—" ? ` · ${dataset.created}` : "";
  return `${dataset.provider} · ${dataset.pieceCount} pieces · ${dataset.size}${created}`;
}

export interface DriveMark {
  pieces: string;
  drive: boolean;
  driveName?: string;
}

export function driveMarkKey(chainId: number, root: string, id: string): string {
  return `fifolders:dataset-drive:${chainId}:${root.toLowerCase()}:${id}`;
}

/** Cached detection; stale once the dataset's piece count changes. */
export function loadDriveMark(chainId: number, root: string, id: string, pieces: string): DriveMark | null {
  try {
    const mark = JSON.parse(localStorage.getItem(driveMarkKey(chainId, root, id)) || "null") as DriveMark | null;
    return mark && mark.pieces === pieces ? mark : null;
  } catch {
    return null;
  }
}

export function saveDriveMark(chainId: number, root: string, id: string, mark: DriveMark): void {
  localStorage.setItem(driveMarkKey(chainId, root, id), JSON.stringify(mark));
}

/** Mark datasets whose piece list contains a known manifest piece CID (cid -> volume name or ""). */
export function markDrives<T extends { id: string }>(datasets: T[], pieces: Map<string, string[]>, manifests: Map<string, string>): (T & { drive: boolean; driveName?: string })[] {
  return datasets.map((dataset) => {
    const hit = (pieces.get(dataset.id) ?? []).find((cid) => manifests.has(cid));
    if (hit === undefined) return { ...dataset, drive: false };
    const name = manifests.get(hit) || "";
    return name ? { ...dataset, drive: true, driveName: name } : { ...dataset, drive: true };
  });
}

/**
 * True only when the registry answers with a different commit permission (a pre-session-key deployment).
 * A failed read is retried, then treated as current: guessing "legacy" would send every save through the
 * root wallet and pop an unexpected wallet prompt (e.g. from a FiPen save) instead of using the session key.
 */
export async function isLegacyRegistry(read: () => Promise<string>, expected: string, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      return (await read()).toLowerCase() !== expected.toLowerCase();
    } catch {
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 300 * (i + 1)));
    }
  }
  return false;
}
