/**
 * fiperson/clubs — "Find all my Clubs": read FiClub for the clubs a wallet belongs to (member or admin)
 * and cache the coworker set (everyone in those clubs) for @-mention suggestions. No dependencies: plain eth_call.
 */
import { CALIBRATION_RPC, isAddress, type Address } from "../view/schema.js";
import type { KV } from "../view/resolve.js";

/** FiClub on Filecoin Calibration (deployments/ficlub-calibration.json). */
export const CALIBRATION_FICLUB = "0x4f73E1504d848eC4e3e74047940bD97EA79A3521" as const;
export const COWORKERS_CACHE_PREFIX = "fiperson:clubs:v1:";
const SEL = { clubsOf: "3c2b9cf4", getClub: "5adf16af", listMembers: "c4d63bd4", listAdmins: "7f8e156a" } as const;
const PAGE = 200n;

export interface ClubSummary {
  id: string;
  name: string;
  members: Address[];
  admins: Address[];
  /** This wallet's role in the club. */
  role: "admin" | "member";
}
export interface MyClubs {
  address: Address;
  clubs: ClubSummary[];
  /** Everyone in those clubs except `address`, lowercase, sorted. */
  coworkers: Address[];
  checkedAt: number;
}

/** `eth_call(to, data)` → hex result. */
export type EthCall = (to: string, data: string) => Promise<string>;

export function rpcEthCall(rpcUrl: string = CALIBRATION_RPC, fetchFn: typeof fetch = fetch): EthCall {
  let id = 0;
  return async (to, data) => {
    const res = await fetchFn(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_call", params: [{ to, data }, "latest"] }) });
    const json = (await res.json()) as { result?: string; error?: { message?: string } };
    if (json.error || typeof json.result !== "string") throw new Error(json.error?.message || "eth_call failed");
    return json.result;
  };
}

const word = (v: bigint) => v.toString(16).padStart(64, "0");
const addrWord = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
function words(hex: string): bigint[] {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(BigInt("0x" + h.slice(i, i + 64)));
  return out;
}
/** Decode a lone dynamic array return (`uint256[]` / `address[]`). */
export function decodeArray(hex: string): bigint[] {
  const w = words(hex);
  if (!w.length) return [];
  const at = Number(w[0]! / 32n);
  const n = Number(w[at] ?? 0n);
  return w.slice(at + 1, at + 1 + n);
}
const toAddr = (v: bigint) => ("0x" + v.toString(16).padStart(40, "0")) as Address;
/** First tuple element of getClub: the name string. */
export function decodeClubName(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const w = words(h);
  if (!w.length) return "";
  const off = Number(w[0]!) * 2;
  const len = Number(BigInt("0x" + (h.slice(off, off + 64) || "0")));
  const bytes = h.slice(off + 64, off + 64 + len * 2);
  const arr = new Uint8Array(bytes.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(bytes.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(arr);
}

export interface FindClubsOptions {
  call?: EthCall;
  contract?: string;
  cache?: KV | null;
  now?: number;
}

function defaultCache(): KV | null {
  try {
    return (globalThis as { localStorage?: KV }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Scan FiClub (`clubsOf`, then each club's members and admins) and cache the result for {@link cachedCoworkers}. */
export async function findMyClubs(address: string, opts: FindClubsOptions = {}): Promise<MyClubs> {
  if (!isAddress(address)) throw new Error("Connect a wallet first.");
  const me = address.toLowerCase() as Address;
  const call = opts.call ?? rpcEthCall();
  const to = opts.contract ?? CALIBRATION_FICLUB;
  const ids: bigint[] = [];
  for (let off = 0n; ; off += PAGE) {
    const got = decodeArray(await call(to, "0x" + SEL.clubsOf + addrWord(me) + word(off) + word(PAGE)));
    ids.push(...got);
    if (BigInt(got.length) < PAGE) break;
  }
  const list = async (sel: string, id: bigint) => {
    const out: Address[] = [];
    for (let off = 0n; ; off += PAGE) {
      const got = decodeArray(await call(to, "0x" + sel + word(id) + word(off) + word(PAGE))).map(toAddr);
      out.push(...got);
      if (BigInt(got.length) < PAGE) return out;
    }
  };
  const clubs = await Promise.all(
    [...new Set(ids)].sort((a, b) => (a < b ? -1 : 1)).map(async (id): Promise<ClubSummary> => {
      const [name, members, admins] = await Promise.all([call(to, "0x" + SEL.getClub + word(id)).then(decodeClubName), list(SEL.listMembers, id), list(SEL.listAdmins, id)]);
      return { id: id.toString(), name, members, admins, role: admins.includes(me) ? "admin" : "member" };
    }),
  );
  const coworkers = [...new Set(clubs.flatMap((c) => [...c.members, ...c.admins]))].filter((a) => a !== me).sort() as Address[];
  const result: MyClubs = { address: me, clubs, coworkers, checkedAt: opts.now ?? Date.now() };
  try {
    (opts.cache === undefined ? defaultCache() : opts.cache)?.setItem(COWORKERS_CACHE_PREFIX + me, JSON.stringify(result));
  } catch {
    /* storage blocked */
  }
  return result;
}

/** Last "Find all my Clubs" result for `address` (sync, from localStorage), or null. */
export function cachedClubs(address: string | null | undefined, cache: KV | null = defaultCache()): MyClubs | null {
  if (!address || !isAddress(address)) return null;
  try {
    const raw = cache?.getItem(COWORKERS_CACHE_PREFIX + address.toLowerCase());
    const v = raw ? (JSON.parse(raw) as MyClubs) : null;
    return v && Array.isArray(v.clubs) && Array.isArray(v.coworkers) ? v : null;
  } catch {
    return null;
  }
}

/** Coworkers (club-mates) of `address` from the cache, with the clubs each shares. */
export function cachedCoworkers(address: string | null | undefined, cache: KV | null = defaultCache()): { address: Address; clubs: string[] }[] {
  const mine = cachedClubs(address, cache);
  if (!mine) return [];
  return mine.coworkers.map((a) => ({ address: a, clubs: mine.clubs.filter((c) => c.members.includes(a) || c.admins.includes(a)).map((c) => c.name) }));
}
