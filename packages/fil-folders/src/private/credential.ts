/**
 * The browser's standing access to the owner's private data: a Keysmith Delivery to the session key.
 *
 * At setup the owner's wallet signs Keysmith's `GroupKey` message (twice for a new group key, once when
 * the data set records `foc/kc`) and one `ReadGrant` root claim naming the session key as bearer. The
 * group key is wrapped to the session key's public key. Only the Delivery (claim chain + wrapped key) is
 * stored, next to the session key; the group key itself is never stored. Later loads unwrap it with the
 * session key and sign each gated request with it: no wallet prompts.
 *
 * Filecoin Drive stores a plain Grant the same way; the claim chain added here is what Curio's gate checks.
 */
import * as Keysmith from "@filoz/keysmith";
import type { Address, Hex, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base64UrlToBytes, bytesToBase64Url } from "../bytes.js";

export interface PrivateCredential {
  v: 1;
  chainId: number;
  owner: Address;
  groupKeyId: Hex;
  /** `foc/kc` value (`v2.<32 hex>`), checked against data sets before writing. */
  commitment: string;
  /** Session key address the delivery is wrapped to. */
  bearer: Address;
  /** base64url Keysmith Delivery: claim chain (owner root, node "groupKey") + group key wrapped to the bearer. */
  delivery: string;
  /** Unix seconds: the claim chain's expiry (the session key's). */
  expires: number;
}

export interface OwnerWallet {
  address: Address;
  signTypedData: (args: any) => Promise<Hex>;
}

/** Wallet prompts at setup: GroupKey once (twice for a brand-new group key) plus one ReadGrant. */
export async function createCredential(input: {
  wallet: OwnerWallet;
  /** The browser session key: its address is the claim bearer, its Keysmith wrap key receives the group key. */
  sessionPrivateKey: Hex;
  chainId: number;
  groupKeyId: Hex;
  /** The commitment a data set already records, when the group key exists. */
  commitment?: string;
  expires: number;
}): Promise<{ credential: PrivateCredential; groupKey: Uint8Array }> {
  const session = privateKeyToAccount(input.sessionPrivateKey);
  const ref = { owner: input.wallet.address, groupKeyId: input.groupKeyId };
  const derived = await Keysmith.deriveGroupKey(input.wallet as Keysmith.TypedDataSigner, ref, input.commitment ? { commitment: input.commitment } : {});
  const { chain, nodeKey } = await Keysmith.rootClaim(input.wallet, {
    owner: ref.owner,
    groupKeyId: ref.groupKeyId,
    chainId: BigInt(input.chainId),
    groupKey: derived.groupKey,
    node: "groupKey",
    bearer: session.address,
    maxDepth: 1,
    expires: input.expires,
  });
  const grant = await Keysmith.wrapTo(Keysmith.publicKeyOf(input.sessionPrivateKey), nodeKey, Keysmith.grantDescriptor(ref, "groupKey"));
  const credential: PrivateCredential = {
    v: 1,
    chainId: input.chainId,
    owner: ref.owner,
    groupKeyId: Keysmith.groupKeyId(ref.groupKeyId),
    commitment: derived.commitment,
    bearer: session.address,
    delivery: bytesToBase64Url(Keysmith.encodeDelivery(chain, grant)),
    expires: input.expires,
  };
  return { credential, groupKey: derived.groupKey };
}

export interface OpenedCredential {
  groupKey: Uint8Array;
  chain: Keysmith.ClaimChain;
  bearer: LocalAccount;
  expired: boolean;
  ref: { owner: Address; groupKeyId: Hex };
}

/** Unwrap a stored credential with the session private key; checks owner and group key id. */
export async function openCredential(sessionPrivateKey: Hex, credential: PrivateCredential): Promise<OpenedCredential> {
  const opened = await Keysmith.openDelivery(sessionPrivateKey, base64UrlToBytes(credential.delivery));
  if (opened.claim.owner.toLowerCase() !== credential.owner.toLowerCase()) throw new Error("This credential is for another wallet.");
  if (opened.claim.groupKeyId !== Keysmith.groupKeyId(credential.groupKeyId)) throw new Error("This credential is for another group key.");
  if (!Keysmith.matchesCommitment(opened.key, credential.commitment)) throw new Error("This credential does not match the group key commitment.");
  return {
    groupKey: opened.key,
    chain: opened.chain,
    bearer: privateKeyToAccount(sessionPrivateKey),
    expired: opened.expired,
    ref: { owner: credential.owner, groupKeyId: credential.groupKeyId },
  };
}

export function parseCredential(raw: string | null): PrivateCredential | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PrivateCredential;
    if (parsed?.v !== 1 || !parsed.delivery || !parsed.owner || !parsed.groupKeyId || !parsed.commitment) return null;
    return parsed;
  } catch {
    return null;
  }
}
