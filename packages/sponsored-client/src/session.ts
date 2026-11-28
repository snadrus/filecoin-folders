import {
  AddPiecesPermission,
  CreateDataSetPermission,
  DeleteDataSetPermission,
  SchedulePieceRemovalsPermission,
  fromSecp256k1,
} from "@filoz/synapse-core/session-key";
import { calibration, mainnet } from "@filoz/synapse-core/chains";
import { Synapse } from "@filoz/synapse-sdk";
import {
  createSynapseStorage,
  createViemRegistry,
  openVolume,
  withTransientRetry,
  type Registry,
  type Storage,
  type Volume,
  type ViemRegistryOptions,
  type OpenVolumeOptions,
} from "fil-folders";
import { createPublicClient, createWalletClient, custom, getAddress, hashTypedData, http, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAIN_IDS, DEFAULT_VOLUME, DEFAULT_SPONSOR_LIMITS, registryConfig, rpcOf, sponsoredPurchaseUsd, type ChainChoice } from "./config.js";
import { buySponsoredCredits, createSponsoredDataset, sponsorPricing, rememberedCheckoutSession, withHandoverRetry, type HandoverRetryStatus } from "./credits.js";
import { trackSponsoredOp } from "./ops-log.js";
import { findPasskeyAccount, findSponsoredAccount, passkeySponsorSigner, sessionSponsorSigner, walletSponsorSigner, type SponsorSigner, type SponsorTyped } from "./auth.js";
import { guardSponsoredSynapse, guardStorage } from "./guards.js";
import {
  SESSION_TTL_SEC,
  loadLastDataset,
  loadPasskey,
  loadSession,
  loadStoredWallet,
  saveLastDataset,
  saveSession,
  sessionUsable,
  type StoredSession,
} from "./persist.js";
import { directPasskeyHost, encodeContractAssertion, type PasskeyHost, type PasskeyPublicKey } from "./passkey.js";
import { addSessionKeyData, liveRemovalAdapters, relayExecute, sponsoredTransport, type RemovalAdapters } from "./relay.js";


function handoverCall<T>(id: string, kind: "upload" | "commit" | "dataset", label: string, action: () => Promise<T>): Promise<T> {
  const sessionId = rememberedCheckoutSession();
  trackSponsoredOp({ id, kind, label, state: "sent" });
  const onStatus = (state: HandoverRetryStatus, detail?: string) => trackSponsoredOp({ id, kind, label, state, detail });
  return withHandoverRetry(action, { sessionId, onStatus });
}

function withHandoverCalls(storage: Storage, registry: Registry): { storage: Storage; registry: Registry } {
  return {
    storage: { ...storage, put: (data, opts) => handoverCall(`addpieces:${Date.now()}`, "upload", "Add pieces to storage", () => storage.put(data, opts)) },
    registry: { ...registry, commit: (input) => handoverCall(`commit:${Date.now()}`, "commit", "Commit folder registry", () => registry.commit(input)) },
  };
}

export const SESSION_PERMISSION_ERROR =
  "Session key does not have the required permissions. Please login and sync expirations with the session key first.";

const FRESH_LOGIN_MS = 10 * 60 * 1000;
const confirmedLogins = new Map<string, number>();

export type TypedDataPayload = {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

export type Identity =
  | { kind: "passkey"; key: PasskeyPublicKey; passkeys?: PasskeyHost }
  | { kind: "wallet"; address: Address; sign: (typed: TypedDataPayload) => Promise<Hex> };

export interface SponsoredSession {
  chain: ChainChoice;
  payer: Address;
  datasetId: string;
  synapse: Synapse;
  storage: Storage;
  registry: Registry;
  volume: Volume;
  signer: SponsorSigner;
  removals: RemovalAdapters;
  buyCredits: (usd?: number) => Promise<{ url: string; id: string; first: boolean }>;
}

export type SignInResult = SponsoredSession | { checkoutUrl: string; id: string; first: boolean };

function viemChain(chain: ChainChoice) {
  return chain === "mainnet" ? mainnet : calibration;
}

function publicTransport(chain: ChainChoice) {
  const client = createPublicClient({ chain: viemChain(chain) as never, transport: withTransientRetry(http(rpcOf(chain))) });
  return {
    client: client as unknown as PublicClient,
    transport: custom({ request: (args: { method: string; params?: unknown }) => client.request(args as never) }),
  };
}

function markAuthorized(sessionAddress: Address): void {
  confirmedLogins.set(sessionAddress.toLowerCase(), Date.now());
}

function justAuthorized(stored: StoredSession, nowSec: bigint): boolean {
  const at = confirmedLogins.get(stored.sessionAddress.toLowerCase());
  return Boolean(at && Date.now() - at < FRESH_LOGIN_MS && sessionUsable(stored, nowSec));
}

function passkeysOf(identity: Identity): PasskeyHost {
  return identity.kind === "passkey" ? (identity.passkeys ?? directPasskeyHost) : directPasskeyHost;
}

export function ownerSigner(identity: Identity): SponsorSigner {
  if (identity.kind === "passkey") {
    const passkeys = passkeysOf(identity);
    return passkeySponsorSigner(identity.key, (challenge) => passkeys.assert(identity.key.credentialId, challenge));
  }
  return walletSponsorSigner(identity.address, (typed) => identity.sign(typed as unknown as TypedDataPayload));
}

export async function resolvePayer(identity: Identity, chain: ChainChoice): Promise<Address | null> {
  if (identity.kind === "passkey") return findPasskeyAccount(identity.key, chain);
  return findSponsoredAccount(identity.address, chain);
}

export function sessionSigner(payer: Address, chain: ChainChoice, preferSession = true): SponsorSigner | null {
  const stored = preferSession ? loadSession(CHAIN_IDS[chain], payer) : null;
  if (stored && BigInt(stored.expiry) > BigInt(Math.floor(Date.now() / 1000) + 300)) {
    return sessionSponsorSigner(payer, stored.privateKey);
  }
  return null;
}

export function sponsorSignerFor(payer: Address, identity: Identity, chain: ChainChoice, preferSession = true): SponsorSigner {
  return sessionSigner(payer, chain, preferSession) ?? ownerSigner(identity);
}

function signExecute(identity: Identity): (typed: Parameters<Parameters<typeof relayExecute>[0]["sign"]>[0]) => Promise<Hex> {
  return async (typed) => {
    if (identity.kind === "passkey") {
      return encodeContractAssertion(await passkeysOf(identity).assert(identity.key.credentialId, hashTypedData(typed)));
    }
    return identity.sign(typed as unknown as SponsorTyped);
  };
}

/** Register (or renew) a browser session key on the locked account. The owner signs once; the sponsor submits. */
export async function authorizeSessionKey(input: {
  chain: ChainChoice;
  payer: Address;
  identity: Identity;
  privateKey?: Hex;
  expiresAt?: bigint;
}): Promise<StoredSession> {
  const privateKey = input.privateKey ?? generatePrivateKey();
  const expiresAt = input.expiresAt ?? BigInt(Math.floor(Date.now() / 1000) + SESSION_TTL_SEC);
  const sessionAddress = privateKeyToAccount(privateKey).address;
  const { client } = publicTransport(input.chain);
  const hash = await relayExecute({
    client,
    chainId: CHAIN_IDS[input.chain],
    account: input.payer,
    target: input.payer,
    data: addSessionKeyData(sessionAddress, expiresAt),
    sign: signExecute(input.identity),
    chain: input.chain,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Session key login failed.");
  const stored: StoredSession = { v: 1, chainId: CHAIN_IDS[input.chain], root: input.payer, privateKey, sessionAddress, expiry: expiresAt.toString() };
  saveSession(stored);
  markAuthorized(sessionAddress);
  return stored;
}

function sponsoredSessionKey(chain: ChainChoice, stored: StoredSession) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const expiry = BigInt(stored.expiry);
  if (!justAuthorized(stored, now) && !sessionUsable(stored, now)) throw new Error(SESSION_PERMISSION_ERROR);
  return fromSecp256k1({
    privateKey: stored.privateKey,
    root: stored.root,
    chain: viemChain(chain),
    transport: withTransientRetry(http(rpcOf(chain))),
    expirations: {
      [CreateDataSetPermission]: expiry,
      [AddPiecesPermission]: expiry,
      [SchedulePieceRemovalsPermission]: expiry,
      [DeleteDataSetPermission]: expiry,
    },
  });
}

export interface OpenSponsoredVolumeOptions {
  chain: ChainChoice;
  volumeName?: string;
  datasetId?: string;
  payer?: Address;
  identity?: Identity;
  wrapStorage?: (storage: Storage) => Storage;
  wrapRegistry?: (registry: Registry) => Registry;
  /** Passed to createViemRegistry so Calibration v1 heads still migrate to v2. */
  wrapMigration?: ViemRegistryOptions["wrapMigration"];
  encryption?: OpenVolumeOptions["encryption"];
  onReplication?: Parameters<typeof createSynapseStorage>[1] extends infer O ? O extends { onReplication?: infer C } ? C : never : never;
  /**
   * Private (read=restricted) data sets: return the storage, encryption and registry volume name to open the volume
   * with, or null for a public data set. The app supplies this (it holds the Keysmith signer); nothing here sees keys.
   */
  privateVolume?: (ctx: { synapse: Synapse; datasetId: string }) => Promise<PrivateVolumeParts | null>;
}

export interface PrivateVolumeParts {
  storage: Storage;
  encryption: NonNullable<OpenVolumeOptions["encryption"]>;
  name: string;
  opened?(volume: Volume): void;
}

/** Build Synapse + registry + volume for a live sponsored session. Throws if the session key or dataset is missing. */
export async function openSponsoredVolume(opts: OpenSponsoredVolumeOptions): Promise<SponsoredSession> {
  const chain = opts.chain;
  const volumeName = opts.volumeName ?? DEFAULT_VOLUME;
  const payer = opts.payer ?? (opts.identity ? await resolvePayer(opts.identity, chain) : null);
  if (!payer) throw new Error("Add credits first: your first purchase sets up your storage account.");
  const stored = loadSession(CHAIN_IDS[chain], payer);
  if (!stored) throw new Error("Authorize the session key first.");
  const datasetId = opts.datasetId || loadLastDataset(CHAIN_IDS[chain], payer) || "";
  if (!datasetId || datasetId.startsWith("provider:")) {
    throw new Error("Sponsored accounts must not create datasets. Call createSponsoredDataset first.");
  }

  const { client, transport } = publicTransport(chain);
  const viem = viemChain(chain);
  const synapse = Synapse.create({
    account: payer,
    chain: viem,
    transport,
    source: "fifolders",
    sessionKey: sponsoredSessionKey(chain, stored),
  });
  guardSponsoredSynapse(synapse as never);

  let storage = createSynapseStorage(synapse as never, {
    dataSetId: BigInt(datasetId),
    copies: 1,
    ...(opts.onReplication ? { onReplication: opts.onReplication } : {}),
  });
  const privateParts = opts.privateVolume ? await opts.privateVolume({ synapse, datasetId }) : null;
  if (privateParts) storage = privateParts.storage;
  storage = guardStorage(opts.wrapStorage && !privateParts ? opts.wrapStorage(storage) : storage);

  const config = registryConfig(chain);
  const registryWallet = createWalletClient({
    account: payer,
    chain: viem as never,
    transport: sponsoredTransport({ rpc: rpcOf(chain), chainId: CHAIN_IDS[chain], account: payer, sessionKey: stored.privateKey, chain }),
  });
  let registry = createViemRegistry({
    address: config.address,
    publicClient: client,
    walletClient: registryWallet,
    fromBlock: config.fromBlock,
    // Gasless: the account itself is the owner, so commits go to allowlisted `commit`, not `commitFor`.
    signer: "auto",
    ...(opts.wrapMigration ? { wrapMigration: opts.wrapMigration } : {}),
  });
  if (opts.wrapRegistry) registry = opts.wrapRegistry(registry);
  ({ storage, registry } = withHandoverCalls(storage, registry));

  const volume = await openVolume({ storage, registry, owner: payer, name: privateParts?.name ?? volumeName, encryption: privateParts?.encryption ?? opts.encryption });
  privateParts?.opened?.(volume);
  const identity = opts.identity;
  const signer = identity ? sponsorSignerFor(payer, identity, chain) : sessionSponsorSigner(payer, stored.privateKey);
  const removals = liveRemovalAdapters({
    client,
    context: (id) => synapse.storage.createContext({ dataSetId: BigInt(id), withCDN: false }) as never,
  });
  saveLastDataset(CHAIN_IDS[chain], payer, datasetId);

  return {
    chain,
    payer,
    datasetId,
    synapse,
    storage,
    registry,
    volume,
    signer,
    removals,
    async buyCredits(usd) {
      const limits = await sponsorPricing(chain).catch(() => ({ ...DEFAULT_SPONSOR_LIMITS, setupFeeUsd: 1.5, reserveUsd: 1, testMode: chain === "calibration" }));
      const amount = sponsoredPurchaseUsd(limits, false, usd);
      const here = typeof window !== "undefined" && window.location ? `${window.location.origin}${window.location.pathname ?? "/"}` : "http://localhost/";
      return buySponsoredCredits(signer, CHAIN_IDS[chain], {
        usd: amount,
        successUrl: `${here}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${here}?checkout=cancel`,
      }, chain);
    },
  };
}

export interface SignInOptions {
  chain: ChainChoice;
  identity: Identity;
  volumeName?: string;
  datasetId?: string;
  usd?: number;
  successUrl?: string;
  cancelUrl?: string;
}

/**
 * Find or create the payer (first purchase returns a Stripe Checkout URL), authorize a session key if needed,
 * then open the volume.
 */
export async function signIn(opts: SignInOptions): Promise<SignInResult> {
  const payer = await resolvePayer(opts.identity, opts.chain);
  if (!payer) {
    const limits = await sponsorPricing(opts.chain).catch(() => ({ ...DEFAULT_SPONSOR_LIMITS, setupFeeUsd: 1.5, reserveUsd: 1, testMode: opts.chain === "calibration" }));
    const usd = sponsoredPurchaseUsd(limits, true, opts.usd);
    const here = typeof window !== "undefined" && window.location ? `${window.location.origin}${window.location.pathname ?? "/"}` : "http://localhost/";
    const checkout = await buySponsoredCredits(ownerSigner(opts.identity), CHAIN_IDS[opts.chain], {
      usd,
      successUrl: opts.successUrl ?? `${here}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: opts.cancelUrl ?? `${here}?checkout=cancel`,
    }, opts.chain);
    return { checkoutUrl: checkout.url, id: checkout.id, first: checkout.first };
  }
  const stored = loadSession(CHAIN_IDS[opts.chain], payer);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (!sessionUsable(stored, now)) {
    await authorizeSessionKey({ chain: opts.chain, payer, identity: opts.identity, privateKey: stored?.privateKey });
  }
  let datasetId = opts.datasetId || loadLastDataset(CHAIN_IDS[opts.chain], payer) || "";
  if (!datasetId || datasetId.startsWith("provider:")) {
    const signer = sponsorSignerFor(payer, opts.identity, opts.chain);
    const made = await createSponsoredDataset(signer, CHAIN_IDS[opts.chain], { app: "fifolders", volume: opts.volumeName ?? DEFAULT_VOLUME, created: new Date().toISOString() }, opts.chain);
    datasetId = made.dataSetId;
    saveLastDataset(CHAIN_IDS[opts.chain], payer, datasetId);
  }
  return openSponsoredVolume({ chain: opts.chain, volumeName: opts.volumeName, datasetId, payer, identity: opts.identity });
}

/** Reuse a still-valid stored session (passkey or wallet remembered on this origin). */
export async function restore(chain: ChainChoice, volumeName = DEFAULT_VOLUME): Promise<SponsoredSession | null> {
  const passkey = loadPasskey();
  const wallet = loadStoredWallet();
  let payer: Address | null = null;
  let identity: Identity | undefined;
  if (passkey) {
    payer = await findPasskeyAccount(passkey, chain).catch(() => null);
    if (payer) identity = { kind: "passkey", key: passkey };
  }
  if (!payer && wallet) {
    payer = await findSponsoredAccount(getAddress(wallet.address), chain).catch(() => null);
    // Wallet restore has no sign function; session key must already be authorized.
  }
  if (!payer) return null;
  const stored = loadSession(CHAIN_IDS[chain], payer);
  if (!sessionUsable(stored, BigInt(Math.floor(Date.now() / 1000)))) return null;
  const datasetId = loadLastDataset(CHAIN_IDS[chain], payer);
  if (!datasetId) return null;
  try {
    return await openSponsoredVolume({ chain, volumeName, datasetId, payer, identity });
  } catch {
    return null;
  }
}

export { DEFAULT_VOLUME };
