/**
 * fiperson/groups — club shared private folders on chain (FiClubVault), next to FiClub's member lists.
 *
 * Flow: a person sets up FiPerson (their profile publishes a member key: `memberKey: { address, wrapKey }`,
 * derived from a wallet signature by `fil-folders/private` `deriveMemberKey`), gives their person link to a
 * club admin; the admin's Accept adds them to FiClub, stores the folder key wrapped to their member key in
 * FiClubVault (`encodeGrant`), and authorizes that key as a PDP session key on the folder's data set. The
 * person's "Find my groups" (`findMyGroups`) then lists the clubs and their folders with a key waiting.
 *
 * Crypto (wrapping, opening) is in `fil-folders/private` (club.ts); this module is chain I/O only.
 */
import { decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { findMyClubs, rpcEthCall, type ClubSummary, type EthCall, type FindClubsOptions } from "../clubs/index.js";
import { isAddress, type IdentityV1 } from "../view/schema.js";

/** FiClubVault on Filecoin Calibration (deployments/ficlubvault-calibration.json), bound to FiClub 0x412B…2A55A03. */
export const CALIBRATION_FICLUB_VAULT = "0x935009a6a3Bee6BbF86BF352c0FE16c4689b7CF3" as const;

export const FICLUB_VAULT_ABI = [
  { type: "function", name: "setFolder", stateMutability: "nonpayable", inputs: [{ name: "clubId", type: "uint256" }, { name: "descriptor", type: "bytes" }], outputs: [] },
  {
    type: "function",
    name: "grant",
    stateMutability: "nonpayable",
    inputs: [
      { name: "clubId", type: "uint256" },
      { name: "member", type: "address" },
      { name: "memberKey", type: "address" },
      { name: "delivery", type: "bytes" },
      { name: "entry", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "revoke", stateMutability: "nonpayable", inputs: [{ name: "clubId", type: "uint256" }, { name: "member", type: "address" }], outputs: [] },
  {
    type: "function",
    name: "folderOf",
    stateMutability: "view",
    inputs: [{ name: "clubId", type: "uint256" }],
    outputs: [{ name: "descriptor", type: "bytes" }, { name: "version", type: "uint256" }],
  },
  {
    type: "function",
    name: "grantsOf",
    stateMutability: "view",
    inputs: [{ name: "clubId", type: "uint256" }, { name: "members", type: "address[]" }],
    outputs: [
      {
        name: "out",
        type: "tuple[]",
        components: [
          { name: "memberKey", type: "address" },
          { name: "updatedAt", type: "uint64" },
          { name: "by", type: "address" },
          { name: "delivery", type: "bytes" },
          { name: "entry", type: "bytes" },
        ],
      },
    ],
  },
] as const;

export interface VaultGrant {
  member: Address;
  memberKey: Address;
  updatedAt: number;
  by: Address;
  delivery: Hex;
  entry: Hex;
}

export interface GroupFolder {
  /** JSON descriptor bytes (decode with fil-folders/private `decodeFolderDescriptor`). */
  descriptor: Hex;
  version: number;
}

export const encodeSetFolder = (clubId: bigint | string, descriptor: Uint8Array | Hex): Hex =>
  encodeFunctionData({ abi: FICLUB_VAULT_ABI, functionName: "setFolder", args: [BigInt(clubId), toHexBytes(descriptor)] });

export const encodeGrant = (clubId: bigint | string, member: Address, memberKey: Address, delivery: Uint8Array | Hex, entry: Uint8Array | Hex = "0x"): Hex =>
  encodeFunctionData({ abi: FICLUB_VAULT_ABI, functionName: "grant", args: [BigInt(clubId), getAddress(member), getAddress(memberKey), toHexBytes(delivery), toHexBytes(entry)] });

export const encodeRevoke = (clubId: bigint | string, member: Address): Hex =>
  encodeFunctionData({ abi: FICLUB_VAULT_ABI, functionName: "revoke", args: [BigInt(clubId), getAddress(member)] });

export async function readFolder(clubId: bigint | string, opts: { call?: EthCall; vault?: string } = {}): Promise<GroupFolder | null> {
  const call = opts.call ?? rpcEthCall();
  const data = encodeFunctionData({ abi: FICLUB_VAULT_ABI, functionName: "folderOf", args: [BigInt(clubId)] });
  const [descriptor, version] = decodeFunctionResult({ abi: FICLUB_VAULT_ABI, functionName: "folderOf", data: (await call(opts.vault ?? CALIBRATION_FICLUB_VAULT, data)) as Hex });
  return descriptor === "0x" ? null : { descriptor, version: Number(version) };
}

export async function readGrants(clubId: bigint | string, members: Address[], opts: { call?: EthCall; vault?: string } = {}): Promise<VaultGrant[]> {
  if (!members.length) return [];
  const call = opts.call ?? rpcEthCall();
  const list = members.map((m) => getAddress(m));
  const data = encodeFunctionData({ abi: FICLUB_VAULT_ABI, functionName: "grantsOf", args: [BigInt(clubId), list] });
  const out = decodeFunctionResult({ abi: FICLUB_VAULT_ABI, functionName: "grantsOf", data: (await call(opts.vault ?? CALIBRATION_FICLUB_VAULT, data)) as Hex });
  return out
    .map((g, i) => ({ member: list[i]!, memberKey: g.memberKey, updatedAt: Number(g.updatedAt), by: g.by, delivery: g.delivery, entry: g.entry }))
    .filter((g) => g.delivery !== "0x");
}

export interface MyGroup {
  club: ClubSummary;
  folder: GroupFolder | null;
  /** This wallet's stored key, when an admin accepted it. */
  grant: VaultGrant | null;
  /** Everyone's stored entries (sealed directory entries; open with the folder key). */
  directory: VaultGrant[];
  status: "ready" | "waiting" | "no-folder";
}

/** "Find my groups": my clubs (FiClub), each club's shared folder and my key in FiClubVault. */
export async function findMyGroups(address: string, opts: FindClubsOptions & { vault?: string } = {}): Promise<MyGroup[]> {
  if (!isAddress(address)) throw new Error("Connect a wallet first.");
  const call = opts.call ?? rpcEthCall();
  const mine = await findMyClubs(address, { ...opts, call });
  const me = getAddress(address);
  return Promise.all(
    mine.clubs.map(async (club): Promise<MyGroup> => {
      const everyone = [...new Set([...club.members, ...club.admins].map((a) => a.toLowerCase()))] as Address[];
      const [folder, directory] = await Promise.all([readFolder(club.id, { call, vault: opts.vault }), readGrants(club.id, everyone, { call, vault: opts.vault })]);
      const grant = directory.find((g) => g.member === me) ?? null;
      return { club, folder, grant, directory, status: !folder ? "no-folder" : grant ? "ready" : "waiting" };
    }),
  );
}

/** The member key a FiPerson profile publishes (extra field, preserved by parseIdentity). */
export interface PublishedMemberKey {
  address: Address;
  wrapKey: Hex;
}
export const MEMBER_KEY_FIELD = "memberKey" as const;

export function memberKeyOf(identity: IdentityV1 | null | undefined): PublishedMemberKey | null {
  const raw = identity?.[MEMBER_KEY_FIELD] as Partial<PublishedMemberKey> | undefined;
  if (!raw || !isAddress(raw.address) || typeof raw.wrapKey !== "string" || !/^0x04[0-9a-fA-F]{128}$/.test(raw.wrapKey)) return null;
  return { address: getAddress(raw.address), wrapKey: raw.wrapKey as Hex };
}

export function withMemberKey<T extends IdentityV1>(identity: T, key: PublishedMemberKey): T {
  return { ...identity, [MEMBER_KEY_FIELD]: { address: getAddress(key.address), wrapKey: key.wrapKey } };
}

/** The wallet a person link points at: `/person/?id=0x…`, `…/identity/?id=…`, or a bare address. */
export function personFromLink(link: string): { address: Address; fragment: string } | null {
  const text = link.trim();
  if (isAddress(text)) return { address: getAddress(text), fragment: "" };
  try {
    const url = new URL(text);
    const id = url.searchParams.get("id") ?? url.searchParams.get("address") ?? "";
    return isAddress(id) ? { address: getAddress(id), fragment: url.hash.replace(/^#/, "") } : null;
  } catch {
    return null;
  }
}

function toHexBytes(v: Uint8Array | Hex): Hex {
  if (typeof v === "string") return v;
  return `0x${[...v].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
