import type { Address, Hex } from "viem";

/** Seven days. Renew extends the same key; it does not mint a new one. */
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;
export const SESSION_ORIGIN = "fifolders";
const SESSION_SKEW_SEC = 60n;

export const PASSKEY_KEY = "fifolders:passkey";
export const WALLET_KEY = "fifolders:wallet";

export function walletStorageKey(): string {
  return WALLET_KEY;
}

export interface StoredSession {
  v: 1;
  chainId: number;
  root: Address;
  privateKey: Hex;
  sessionAddress: Address;
  expiry: string;
}

export interface StoredPasskey {
  credentialId: string;
  x: Hex;
  y: Hex;
}

export interface StoredWallet {
  rdns: string;
  address: Address;
  chain: "calibration" | "mainnet";
}

export function sessionStorageKey(chainId: number, root: string): string {
  return `fifolders:session:${chainId}:${root.toLowerCase()}`;
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
  return BigInt(session.expiry) > nowSec + SESSION_SKEW_SEC;
}

export function loadLastDataset(chainId: number, root: string): string | null {
  return localStorage.getItem(datasetStorageKey(chainId, root));
}

export function saveLastDataset(chainId: number, root: string, id: string): void {
  localStorage.setItem(datasetStorageKey(chainId, root), id);
}

export function loadPasskey(): StoredPasskey | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(PASSKEY_KEY) ?? "null") as StoredPasskey | null;
    return parsed?.credentialId && parsed.x && parsed.y ? parsed : null;
  } catch {
    return null;
  }
}

export function savePasskey(key: StoredPasskey): void {
  localStorage.setItem(PASSKEY_KEY, JSON.stringify(key));
}

export function loadStoredWallet(): StoredWallet | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(WALLET_KEY) ?? "null") as StoredWallet | null;
    if (!parsed?.address || parsed.address === "0x0000000000000000000000000000000000000000") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function pendingSessionStorageKey(chainId: number): string {
  return `fifolders:session:pending:${chainId}`;
}

export function loadPendingSession(chainId: number): StoredSession | null {
  const raw = localStorage.getItem(pendingSessionStorageKey(chainId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (parsed?.v !== 1 || !parsed.privateKey || !parsed.sessionAddress || !parsed.expiry) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePendingSession(session: StoredSession): void {
  localStorage.setItem(pendingSessionStorageKey(session.chainId), JSON.stringify(session));
}

export function clearPendingSession(chainId: number): void {
  localStorage.removeItem(pendingSessionStorageKey(chainId));
}

/** After handover: move the pre-checkout session key onto the assigned account address. */
export function bindPendingSession(chainId: number, root: Address): StoredSession | null {
  const pending = loadPendingSession(chainId);
  if (!pending) return null;
  const bound: StoredSession = { ...pending, root };
  saveSession(bound);
  clearPendingSession(chainId);
  return bound;
}
