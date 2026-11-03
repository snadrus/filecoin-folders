/** FiClub pure helpers: EIP-712 typed data for RemoveAdmin and the portable step-1 blob. */
import { getAddress, isAddress, type Address, type Hex } from "viem";

export interface ClubView {
  id: bigint;
  name: string;
  creator: Address;
  nonce: bigint;
  members: Address[];
  admins: Address[];
}

export const REMOVE_ADMIN_TYPES = {
  RemoveAdmin: [
    { name: "clubId", type: "uint256" },
    { name: "target", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface RemoveAdminMessage {
  clubId: bigint;
  target: Address;
  nonce: bigint;
  deadline: bigint;
}

export function domainOf(chainId: number, verifyingContract: Address) {
  return { name: "FiClub", version: "1", chainId, verifyingContract } as const;
}

/** JSON for eth_signTypedData_v4 (numbers as decimal strings). */
export function typedDataJson(chainId: number, contract: Address, msg: RemoveAdminMessage): string {
  return JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...REMOVE_ADMIN_TYPES,
    },
    primaryType: "RemoveAdmin",
    domain: domainOf(chainId, contract),
    message: { clubId: msg.clubId.toString(), target: msg.target, nonce: msg.nonce.toString(), deadline: msg.deadline.toString() },
  });
}

/** Portable step-1 blob: everything a second admin needs to co-sign and submit. */
export interface RemovalBlob {
  kind: "ficlub/remove-admin";
  v: 1;
  chainId: number;
  contract: Address;
  clubId: string;
  clubName: string;
  target: Address;
  nonce: string;
  deadline: string;
  signer1: Address;
  sig1: Hex;
}

export function encodeBlob(blob: RemovalBlob): string {
  return JSON.stringify(blob, null, 2);
}

export class BlobError extends Error {}

export function parseBlob(text: string): RemovalBlob {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    throw new BlobError("That is not a FiClub removal signature (not JSON).");
  }
  if (raw?.kind !== "ficlub/remove-admin" || raw.v !== 1) throw new BlobError("That is not a FiClub removal signature.");
  for (const k of ["contract", "target", "signer1"] as const) if (typeof raw[k] !== "string" || !isAddress(raw[k] as string)) throw new BlobError(`Bad ${k} address.`);
  for (const k of ["clubId", "nonce", "deadline"] as const) if (typeof raw[k] !== "string" || !/^\d+$/.test(raw[k] as string)) throw new BlobError(`Bad ${k}.`);
  if (typeof raw.chainId !== "number") throw new BlobError("Bad chainId.");
  if (typeof raw.sig1 !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(raw.sig1)) throw new BlobError("Bad signature (need 65 bytes).");
  return {
    kind: "ficlub/remove-admin",
    v: 1,
    chainId: raw.chainId,
    contract: getAddress(raw.contract as string),
    clubId: raw.clubId as string,
    clubName: typeof raw.clubName === "string" ? raw.clubName : "",
    target: getAddress(raw.target as string),
    nonce: raw.nonce as string,
    deadline: raw.deadline as string,
    signer1: getAddress(raw.signer1 as string),
    sig1: raw.sig1 as Hex,
  };
}

/** Check a parsed blob against the current club state. Returns problems (empty = OK to co-sign). */
export function checkBlob(blob: RemovalBlob, ctx: { chainId: number; contract: Address; club: ClubView; me: Address; now: number }): string[] {
  const out: string[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (blob.chainId !== ctx.chainId || !same(blob.contract, ctx.contract)) out.push("Signed for a different network or contract.");
  if (BigInt(blob.clubId) !== ctx.club.id) out.push("Signed for a different club.");
  if (BigInt(blob.nonce) !== ctx.club.nonce) out.push("Out of date: another admin change happened since it was signed (nonce moved). Ask for a new step-1 signature.");
  if (Number(blob.deadline) < ctx.now) out.push("Expired: the signature deadline has passed.");
  if (!ctx.club.admins.some((a) => same(a, blob.target))) out.push("The target is no longer an admin.");
  if (!ctx.club.admins.some((a) => same(a, blob.signer1))) out.push("The first signer is no longer an admin.");
  if (ctx.club.admins.length <= 2) out.push("This club has 2 or fewer admins; remove directly instead.");
  if (same(blob.signer1, ctx.me)) out.push("You signed step 1. A second, different admin must co-sign.");
  if (!ctx.club.admins.some((a) => same(a, ctx.me))) out.push("Your connected wallet is not an admin of this club.");
  return out;
}
