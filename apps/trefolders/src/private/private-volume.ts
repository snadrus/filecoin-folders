/**
 * Opening a TreFolders volume in a private (read-restricted) data set, wallet sign-in only.
 *
 * - Credential: the wallet signs Keysmith's GroupKey (once; twice for a brand-new key) and one ReadGrant naming
 *   this browser's session key. Only the resulting Delivery is stored (next to the session key), so later loads
 *   and every gated read happen without wallet prompts until the session key expires.
 * - Storage: each commit piece is FEE-encrypted (outer CAR `encrypted.fee`) and read back through Curio's
 *   `/download/` with a FOC-Grant signed by the session key. One copy (Curio cannot replicate private pieces yet).
 * - Files: per-file keys under the volume key, so one file can be shared by link.
 */
import type { Address, Hex } from "viem";
import type { Storage, Volume } from "fil-folders";
import {
  Keysmith,
  createCredential,
  createPrivateStorage,
  defaultGroupKeyId,
  describeStatuses,
  fetchGated,
  openCredential,
  parseCredential,
  privateDataSetMetadata,
  volumeGroup,
  volumeKeyFromGroupKey,
  type PrivateCredential,
} from "fil-folders/private";
import { setPrivateShareMaker } from "./share-hook.js";
import { makeVolumeFileShare } from "./share-link.js";

export interface WalletSigner {
  address: Address;
  signTypedData: (args: any) => Promise<Hex>;
}

const credKey = (chainId: number, owner: string) => `fifolders:private-cred:${chainId}:${owner.toLowerCase()}`;

export const PRIVATE_INTENTS = {
  groupKey: { title: "Unlock private folders", purpose: "derive your Filecoin encryption key (same as filecoin-pin and Filecoin Drive)", cost: "free (signature only)" },
  readGrant: { title: "Allow this browser to read private folders", purpose: "lets this browser's session key fetch your private pieces until it expires", cost: "free (signature only)" },
} as const;

/** Volume name used in the registry for the private volume of a private data set (kept apart from public ones). */
export function privateVolumeName(volumeName: string): string {
  return `${volumeName} (private)`;
}

/** Metadata for a new private data set. Asks the wallet for the GroupKey signature (twice for a new key). */
export async function privateCreateMetadata(wallet: WalletSigner, chainId: number, base: Record<string, string>, prompt: <T>(intent: object, run: () => Promise<T>) => Promise<T>) {
  const groupKeyId = defaultGroupKeyId(wallet.address);
  const derived = await prompt(PRIVATE_INTENTS.groupKey, () => Keysmith.deriveGroupKey(wallet as never, { owner: wallet.address, groupKeyId }));
  void chainId;
  return { ...base, ...privateDataSetMetadata({ owner: wallet.address, groupKeyId, commitment: derived.commitment }) };
}

/** The stored (or a new) read credential for this session key. */
export async function privateCredential(input: {
  chainId: number;
  wallet: WalletSigner;
  session: { privateKey: Hex; expiry: number };
  commitment?: string;
  prompt: <T>(intent: object, run: () => Promise<T>) => Promise<T>;
}) {
  const owner = input.wallet.address;
  const stored = parseCredential(localStorage.getItem(credKey(input.chainId, owner)));
  const now = Math.floor(Date.now() / 1000);
  if (stored && stored.expires > now + 60 && (!input.commitment || stored.commitment === input.commitment)) {
    try {
      return await openCredential(input.session.privateKey, stored);
    } catch {
      /* another session key: make a new one */
    }
  }
  const groupKeyId = defaultGroupKeyId(owner);
  let made: { credential: PrivateCredential };
  // Two prompts: GroupKey (wrapped inside createCredential) and the ReadGrant.
  made = await input.prompt(PRIVATE_INTENTS.readGrant, () =>
    createCredential({
      wallet: input.wallet,
      sessionPrivateKey: input.session.privateKey,
      chainId: input.chainId,
      groupKeyId,
      ...(input.commitment ? { commitment: input.commitment } : {}),
      expires: input.session.expiry,
    }),
  );
  localStorage.setItem(credKey(input.chainId, owner), JSON.stringify(made.credential));
  return openCredential(input.session.privateKey, made.credential);
}

export function forgetPrivateCredential(chainId: number, owner: string): void {
  localStorage.removeItem(credKey(chainId, owner));
}

/** Wrap a data set's Synapse storage for a private volume, and the matching volume encryption options. */
export async function privateVolumeParts(input: {
  inner: Storage;
  providers: string[];
  credential: Awaited<ReturnType<typeof openCredential>>;
  volumeName: string;
}) {
  const { credential } = input;
  const target = Keysmith.writeTarget(Keysmith.grantDescriptor(credential.ref, "groupKey"), credential.groupKey, volumeGroup(input.volumeName));
  const storage = createPrivateStorage(input.inner, {
    target,
    readKey: credential.groupKey,
    fetchPiece: async (cid) => {
      try {
        return await fetchGated({ providers: input.providers, cid, signer: credential.bearer, chain: credential.chain });
      } catch (error) {
        console.warn("TreFolders private read failed", cid, input.providers.join(","), error instanceof Error ? error.message : error, describeStatuses(error));
        // Pieces from before the volume went private (or plain pieces) still read publicly.
        return input.inner.get(cid).catch(() => {
          throw error;
        });
      }
    },
  });
  const encryption = { key: await volumeKeyFromGroupKey(credential.groupKey), perFileKeys: true as const };
  return { storage, encryption, labels: storage.labels };
}

/** After the volume opens: let Details make fragment share links for files in it (no wallet prompt). */
export function installPrivateShares(input: {
  volume: Volume;
  credential: Awaited<ReturnType<typeof openCredential>>;
  labels: Map<string, Keysmith.PieceLabels>;
  storage: Storage;
  providers: string[];
  chain: "calibration" | "mainnet";
  chainId: number;
}): void {
  setPrivateShareMaker((path, base) => makeVolumeFileShare({ ...input, path, base }));
}
