/**
 * TrePerson on a private TreFolders data set.
 *
 * The identity piece is sealed into the Keysmith group `FiPerson/identity` (on-chain namespace kept as is). A
 * person shares one group link (`#v=pg1&…`, key only in the fragment): it opens every identity piece in that group,
 * so after an update the old link still opens whichever piece the registry pointer names now.
 *
 * Needs `fil-folders` (its `./private` entry) next to this package.
 */
import type { Address, Hex } from "viem";
import type { Storage } from "fil-folders";
import {
  Keysmith,
  createPrivateStorage,
  encodeShareFragment,
  fetchSharedPiece,
  makeGroupShare,
  openShare,
  parseShareFragment,
  type OpenedCredential,
  type OpenedShare,
  type PrivateShare,
} from "fil-folders/private";

/** Keysmith group for identity pieces. */
export const IDENTITY_GROUP = "FiPerson/identity";

/** Storage that seals identity pieces into {@link IDENTITY_GROUP}; pass it where the profile piece is saved. */
export function identityStorage(inner: Storage, credential: OpenedCredential): Storage & { labels: Map<string, Keysmith.PieceLabels> } {
  return createPrivateStorage(inner, {
    target: Keysmith.writeTarget(Keysmith.grantDescriptor(credential.ref, "groupKey"), credential.groupKey, IDENTITY_GROUP),
    readKey: credential.groupKey,
  });
}

/** Fragment (no `#`) for a TrePerson link that opens this person's identity, now and after updates. */
export async function identityShareFragment(input: {
  credential: OpenedCredential;
  chainId: number;
  network: "calibration" | "mainnet";
  providers: string[];
}): Promise<string> {
  const share = await makeGroupShare({
    issuer: { kind: "delegate", signer: input.credential.bearer, chain: input.credential.chain, parentKey: input.credential.groupKey },
    ref: input.credential.ref as { owner: Address; groupKeyId: Hex },
    chainId: input.chainId,
    network: input.network,
    providers: input.providers,
    group: IDENTITY_GROUP,
  });
  return encodeShareFragment(share);
}

/** True for a TrePerson private identity link fragment. */
export function isIdentityFragment(hash: string): boolean {
  const share = parseShareFragment(hash);
  return share?.kind === "group" && share.group === Keysmith.groupPath(IDENTITY_GROUP);
}

/**
 * `fetchPiece` for `resolveIdentity` (from `treperson/view`) when the identity lives in a private data set:
 * reads each piece through Curio's gated `/download/` with the link's grant and decrypts it.
 */
export function privateIdentityFetcher(fragment: string, opts: { fetchImpl?: typeof fetch; providers?: string[] } = {}): (pieceCid: string) => Promise<Uint8Array> {
  const share: PrivateShare | null = parseShareFragment(fragment);
  if (!share || share.kind !== "group") throw new Error("This is not a TrePerson identity link.");
  let opened: Promise<OpenedShare> | null = null;
  return async (pieceCid) => {
    opened ??= openShare(share);
    return fetchSharedPiece(share, await opened, pieceCid, opts);
  };
}
