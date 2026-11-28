/**
 * Share links for private data. Everything secret lives in the URL fragment (never the query string,
 * never a server): the fragment carries a throwaway key T, a Keysmith Delivery whose claim chain names T as
 * bearer (so T can sign Curio `/download/` requests) and whose grant wraps the node key to T, and the
 * providers that hold the piece. This mirrors filecoin-pin's private share links (filecoin-pin#841),
 * extended with a per-file key for files inside TreFolders commit pieces.
 *
 * Kinds:
 * - `file`: one file in a private volume. Grant = that commit piece's key (`piece:<salt>`); plus the file's
 *   own content key, CID and IV. The piece key reveals the commit CAR (encrypted names, other files'
 *   ciphertext); only the file key opens this file.
 * - `group`: a Keysmith group (TrePerson uses `TrePerson/identity`). Opens every piece in that group,
 *   including ones written later, so an identity link keeps working when the profile changes.
 */
import * as Keysmith from "@filoz/keysmith";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { asBuffer, base64ToBytes, base64UrlToBytes, bytesToBase64Url, utf8 } from "../bytes.js";
import { decodeCar } from "../car.js";
import { FILE_AAD } from "../crypto.js";
import { unpadPiece } from "../pad.js";
import { openPiece } from "./envelope.js";
import { fetchGated } from "./gated.js";
import { cidBytes } from "./unixfs-pack.js";

/** Default lifetime of a share link's fetch right (the key itself never expires). */
export const SHARE_LIFETIME_SECONDS = 365 * 24 * 3600;

/** Who signs the share's claim: the owner wallet (a root, one prompt), or a delegate (no prompt). */
export type ShareIssuer =
  | { kind: "owner"; wallet: { signTypedData: (args: any) => Promise<Hex> }; groupKey: Uint8Array; expires?: number }
  | { kind: "delegate"; signer: Keysmith.ClaimSigner; chain: Keysmith.ClaimChain; parentKey: Uint8Array };

interface Common {
  chain: "calibration" | "mainnet";
  providers: string[];
  owner: Address;
  /** base64url Delivery. */
  d: string;
  /** base64url T private key. */
  k: string;
}

export interface FileShare extends Common {
  kind: "file";
  piece: string;
  cid: string;
  iv: string;
  /** base64url per-file key. */
  fk: string;
  name: string;
  size?: number;
  mime?: string;
}

export interface GroupShare extends Common {
  kind: "group";
  group: string;
}

export type PrivateShare = FileShare | GroupShare;

async function issue(
  issuer: ShareIssuer,
  ref: { owner: Address; groupKeyId: Hex },
  chainId: number,
  node: string,
  extra: { piece?: Keysmith.PieceLabels; pieceCid?: Uint8Array },
): Promise<{ d: string; k: string }> {
  const t = generatePrivateKey();
  const bearer = privateKeyToAccount(t);
  const made =
    issuer.kind === "owner"
      ? await Keysmith.rootClaim(issuer.wallet, {
          owner: ref.owner,
          groupKeyId: ref.groupKeyId,
          chainId: BigInt(chainId),
          groupKey: issuer.groupKey,
          node,
          bearer: bearer.address,
          maxDepth: 0,
          expires: issuer.expires ?? Math.floor(Date.now() / 1000) + SHARE_LIFETIME_SECONDS,
          ...extra,
        })
      : await Keysmith.delegateClaim(issuer.signer, issuer.chain, {
          parentKey: issuer.parentKey,
          node,
          bearer: bearer.address,
          maxDepth: 0,
          ...extra,
        });
  const grant = await Keysmith.wrapTo(Keysmith.publicKeyOf(t), made.nodeKey, Keysmith.grantDescriptor(ref, Keysmith.canonicalNode(node)));
  return { d: bytesToBase64Url(Keysmith.encodeDelivery(made.chain, grant)), k: bytesToBase64Url(base64UrlFromHex(t)) };
}

function base64UrlFromHex(hex: Hex): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hexOf(bytes: Uint8Array): Hex {
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Share one file of a private volume. */
export async function makeFileShare(input: {
  issuer: ShareIssuer;
  ref: { owner: Address; groupKeyId: Hex };
  chainId: number;
  network: "calibration" | "mainnet";
  providers: string[];
  piece: string;
  labels: Keysmith.PieceLabels;
  file: { cid: string; iv: string; key: Uint8Array; name: string; size?: number; mime?: string };
}): Promise<FileShare> {
  const { d, k } = await issue(input.issuer, input.ref, input.chainId, Keysmith.pieceNode(input.labels as never), {
    piece: input.labels,
    pieceCid: cidBytes(input.piece),
  });
  const share: FileShare = {
    kind: "file",
    chain: input.network,
    providers: input.providers,
    owner: getAddress(input.ref.owner),
    d,
    k,
    piece: input.piece,
    cid: input.file.cid,
    iv: input.file.iv,
    fk: bytesToBase64Url(input.file.key),
    name: input.file.name,
  };
  if (input.file.size != null) share.size = input.file.size;
  if (input.file.mime) share.mime = input.file.mime;
  return share;
}

/** Share a Keysmith group (e.g. `TrePerson/identity`): opens every piece in it, now and later. */
export async function makeGroupShare(input: {
  issuer: ShareIssuer;
  ref: { owner: Address; groupKeyId: Hex };
  chainId: number;
  network: "calibration" | "mainnet";
  providers: string[];
  group: string;
}): Promise<GroupShare> {
  const { d, k } = await issue(input.issuer, input.ref, input.chainId, `group:${Keysmith.groupPath(input.group)}`, {});
  return { kind: "group", chain: input.network, providers: input.providers, owner: getAddress(input.ref.owner), d, k, group: Keysmith.groupPath(input.group) };
}

const KIND = { file: "pf1", group: "pg1" } as const;

/** Fragment text (no leading `#`). Only the fragment ever holds key material. */
export function encodeShareFragment(share: PrivateShare): string {
  const q = new URLSearchParams();
  q.set("v", KIND[share.kind]);
  q.set("chain", share.chain);
  q.set("by", share.owner);
  q.set("d", share.d);
  q.set("k", share.k);
  if (share.providers.length) q.set("s", share.providers.join(","));
  if (share.kind === "file") {
    q.set("piece", share.piece);
    q.set("cid", share.cid);
    q.set("iv", share.iv);
    q.set("fk", share.fk);
    q.set("name", share.name);
    if (share.size != null) q.set("size", String(share.size));
    if (share.mime) q.set("mime", share.mime);
  } else {
    q.set("group", share.group);
  }
  return q.toString();
}

export function parseShareFragment(hash: string): PrivateShare | null {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const v = q.get("v");
  const d = q.get("d") ?? "";
  const k = q.get("k") ?? "";
  const by = q.get("by") ?? "";
  if (!d || !k || !/^0x[0-9a-fA-F]{40}$/.test(by)) return null;
  const providers = (q.get("s") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => {
      try {
        return /^https?:$/.test(new URL(s).protocol);
      } catch {
        return false;
      }
    });
  const common = { chain: q.get("chain") === "mainnet" ? ("mainnet" as const) : ("calibration" as const), providers, owner: getAddress(by), d, k };
  if (v === KIND.file) {
    const piece = q.get("piece") ?? "";
    const cid = q.get("cid") ?? "";
    const iv = q.get("iv") ?? "";
    const fk = q.get("fk") ?? "";
    if (!piece || !cid || !iv || !fk) return null;
    const share: FileShare = { kind: "file", ...common, piece, cid, iv, fk, name: (q.get("name") ?? "").slice(0, 255) || "Shared file" };
    const size = Number(q.get("size"));
    if (Number.isFinite(size) && size > 0) share.size = size;
    const mime = q.get("mime");
    if (mime) share.mime = mime;
    return share;
  }
  if (v === KIND.group) {
    const group = q.get("group") ?? "";
    if (!group) return null;
    return { kind: "group", ...common, group };
  }
  return null;
}

/** True when a fragment is a private share (so pages can branch without parsing twice). */
export function isPrivateShareFragment(hash: string): boolean {
  return /(^|[#&])v=p[fg]1(&|$)/.test(hash);
}

export interface OpenedShare {
  key: Uint8Array;
  chain: Keysmith.ClaimChain;
  grant: Keysmith.Grant;
  bearer: ReturnType<typeof privateKeyToAccount>;
  expired: boolean;
}

/** Unwrap the link's delivery with its throwaway key T. */
export async function openShare(share: PrivateShare): Promise<OpenedShare> {
  const t = hexOf(base64UrlToBytes(share.k));
  const opened = await Keysmith.openDelivery(t, base64UrlToBytes(share.d));
  if (opened.claim.owner.toLowerCase() !== share.owner.toLowerCase()) throw new Error("This link was signed for another wallet.");
  return { key: opened.key, chain: opened.chain, grant: opened.grant, bearer: privateKeyToAccount(t), expired: opened.expired };
}

/** Fetch a piece through Curio's gate with the link's own key, and decrypt it. */
export async function fetchSharedPiece(share: PrivateShare, opened: OpenedShare, pieceCid: string, opts: { providers?: string[]; fetchImpl?: typeof fetch } = {}): Promise<Uint8Array> {
  const outer = await fetchGated({
    providers: opts.providers ?? share.providers,
    cid: pieceCid,
    signer: opened.bearer,
    chain: opened.chain,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const { plaintext } = await openPiece(outer, opened.key, opened.grant);
  return unpadPiece(plaintext);
}

/** The shared file's plaintext. */
export async function openFileShare(share: FileShare, opts: { providers?: string[]; fetchImpl?: typeof fetch; fetchOuter?: (piece: string) => Promise<Uint8Array> } = {}): Promise<Uint8Array> {
  const opened = await openShare(share);
  let inner: Uint8Array;
  if (opts.fetchOuter) {
    const { plaintext } = await openPiece(await opts.fetchOuter(share.piece), opened.key, opened.grant);
    inner = unpadPiece(plaintext);
  } else {
    inner = await fetchSharedPiece(share, opened, share.piece, opts);
  }
  const block = decodeCar(inner).blocks.get(share.cid);
  if (!block) throw new Error("This file is not in the shared piece.");
  const key = await crypto.subtle.importKey("raw", asBuffer(base64UrlToBytes(share.fk)), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: asBuffer(base64ToBytes(share.iv)), additionalData: asBuffer(utf8(FILE_AAD)) }, key, asBuffer(block)),
    );
  } catch {
    throw new Error("This link's file key does not open the file.");
  }
}
