/**
 * Club (FiClub) shared private folders: the crypto half. Chain I/O lives in `fiperson/groups`.
 *
 * Accept (admin, who owns the folder's data set): sign one ReadGrant root claim on the folder's group, naming
 * the member's derived key as bearer, and wrap the group's key to the member's published wrap key. The
 * resulting Delivery is stored on-chain (FiClubVault) — inert to everyone but the member. The admin also
 * encrypts the member's directory entry (their FiPerson identity link) under the folder key, so every
 * member can read the club directory but outsiders cannot.
 *
 * Find my groups (member): re-derive the member key from the wallet, open the Delivery, and use the key
 * (reads via Curio `/download/`, writes as `writeTarget(group grant)`).
 */
import * as Keysmith from "@filoz/keysmith";
import { getAddress, type Address, type Hex } from "viem";
import { asBuffer, base64UrlToBytes, bytesToBase64Url } from "../bytes.js";

/** What FiClubVault.setFolder stores (JSON, public): where the club's private folder lives. */
export interface ClubFolderDescriptor {
  v: 1;
  /** Data set owner (payer) wallet; the folder's Keysmith owner. */
  owner: Address;
  groupKeyId: Hex;
  /** Keysmith group of the folder (opaque `FiFolders/v…`). */
  group: string;
  /** FiFolders volume name (shown to members). */
  volume: string;
  dataSetId?: string;
  providers?: string[];
  chainId: number;
}

export function encodeFolderDescriptor(d: ClubFolderDescriptor): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ...d, owner: getAddress(d.owner) }));
}

export function decodeFolderDescriptor(bytes: Uint8Array): ClubFolderDescriptor | null {
  try {
    const d = JSON.parse(new TextDecoder().decode(bytes)) as ClubFolderDescriptor;
    if (d?.v !== 1 || !/^0x[0-9a-fA-F]{40}$/.test(d.owner) || !d.group || !d.groupKeyId) return null;
    return d;
  } catch {
    return null;
  }
}

/** Default lifetime of a member's read claim (the key itself does not expire; Accept again to renew). */
export const MEMBER_CLAIM_SECONDS = 365 * 24 * 3600;

/** Admin side of Accept: a Delivery for one member. One wallet prompt (the ReadGrant). */
export async function makeMemberDelivery(input: {
  wallet: Keysmith.ClaimSigner;
  groupKey: Uint8Array;
  folder: ClubFolderDescriptor;
  member: { address: Address; wrapKey: Hex };
  expires?: number;
}): Promise<{ delivery: Uint8Array; folderKey: Uint8Array }> {
  const ref = { owner: input.folder.owner, groupKeyId: input.folder.groupKeyId };
  const node = `group:${Keysmith.groupPath(input.folder.group)}`;
  const { chain, nodeKey } = await Keysmith.rootClaim(input.wallet, {
    ...ref,
    chainId: BigInt(input.folder.chainId),
    groupKey: input.groupKey,
    node,
    bearer: input.member.address,
    // Depth 1: the member's browser can hand one file's key onward in a share link.
    maxDepth: 1,
    expires: input.expires ?? Math.floor(Date.now() / 1000) + MEMBER_CLAIM_SECONDS,
  });
  const grant = await Keysmith.wrapTo(input.member.wrapKey, nodeKey, Keysmith.grantDescriptor(ref, Keysmith.canonicalNode(node)));
  return { delivery: Keysmith.encodeDelivery(chain, grant), folderKey: nodeKey };
}

/** Member side: open the stored Delivery with the derived member key. */
export async function openMemberDelivery(memberPrivateKey: Hex, delivery: Uint8Array, folder: ClubFolderDescriptor) {
  const opened = await Keysmith.openDelivery(memberPrivateKey, delivery);
  if (opened.claim.owner.toLowerCase() !== folder.owner.toLowerCase()) throw new Error("This club key was issued by another wallet.");
  if (canonicalGroup(opened.claim.node) !== Keysmith.groupPath(folder.group)) throw new Error("This club key is for another folder.");
  const descriptor = Keysmith.grantDescriptor({ owner: folder.owner, groupKeyId: folder.groupKeyId }, Keysmith.canonicalNode(opened.claim.node));
  return {
    folderKey: opened.key,
    chain: opened.chain,
    grant: opened.grant,
    expired: opened.expired,
    /** Where this member writes new pieces. */
    target: Keysmith.writeTarget(descriptor, opened.key, folder.group),
  };
}

function canonicalGroup(node: string): string {
  return node.startsWith("group:") ? node.slice("group:".length) : node;
}

const DIR_INFO = new TextEncoder().encode("fiperson/club-directory/v1");

async function directoryKey(folderKey: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", asBuffer(folderKey), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: asBuffer(DIR_INFO) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A member's directory entry (e.g. their FiPerson identity share link), readable by club members only. */
export interface DirectoryEntry {
  member: Address;
  name?: string;
  identityLink?: string;
}

export async function sealDirectoryEntry(folderKey: Uint8Array, entry: DirectoryEntry): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(entry.member.toLowerCase());
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, await directoryKey(folderKey), new TextEncoder().encode(JSON.stringify(entry))),
  );
  const out = new Uint8Array(1 + 12 + ct.byteLength);
  out[0] = 1;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

export async function openDirectoryEntry(folderKey: Uint8Array, member: Address, sealed: Uint8Array): Promise<DirectoryEntry | null> {
  if (sealed.byteLength < 13 + 16 || sealed[0] !== 1) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asBuffer(sealed.subarray(1, 13)), additionalData: asBuffer(new TextEncoder().encode(member.toLowerCase())) },
      await directoryKey(folderKey),
      asBuffer(sealed.subarray(13)),
    );
    const entry = JSON.parse(new TextDecoder().decode(plain)) as DirectoryEntry;
    return entry.member?.toLowerCase() === member.toLowerCase() ? entry : null;
  } catch {
    return null;
  }
}

export const encodeB64 = bytesToBase64Url;
export const decodeB64 = base64UrlToBytes;
