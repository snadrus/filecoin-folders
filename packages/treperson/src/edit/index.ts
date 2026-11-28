/** treperson/edit — write the wallet identity: build/serialize, store the piece, commit the FolderRegistry pointer. */
import { IDENTITY_CONTACTS_KEY_ID, IDENTITY_NS, IDENTITY_PROFILE_KEY_ID, normalizeIdentity, type Address, type Hex, type IdentityDraft, type IdentityV1 } from "../view/schema.js";

export * from "../view/index.js";

/** Minimum Filecoin piece payload (bytes). */
export const MIN_PIECE_BYTES = 127;

/** Validate + normalize a draft (alias of the shared normalizer). */
export function buildIdentity(address: string, draft: IdentityDraft, now?: Date): IdentityV1 {
  return normalizeIdentity(address, draft, now);
}

/** JSON bytes, space-padded to the minimum piece size (JSON ignores trailing whitespace). */
export function encodeIdentity(identity: IdentityV1): Uint8Array {
  const json = JSON.stringify(identity);
  return new TextEncoder().encode(json.length < MIN_PIECE_BYTES ? json.padEnd(MIN_PIECE_BYTES, " ") : json);
}

/** Wallet prompts, named with what they do and cost (TreFolders WalletIntent shape). */
export const IDENTITY_INTENTS = {
  upload: { title: "Store identity piece", purpose: "sign the add-piece request for your existing storage dataset", cost: "free signature; a few bytes billed from your storage deposit" },
  pointer: { title: "Link identity to wallet", purpose: "record the piece in FolderRegistry under your address", cost: "gas ~0.01 FIL" },
} as const;

/** Same actions when the save is gasless (session key + sponsor relay). */
export const IDENTITY_INTENTS_SPONSORED = {
  upload: { title: "Store identity piece", purpose: "sign the add-piece request for your existing storage dataset", cost: "free signature; billed from your TreFolders credits" },
  pointer: { title: "Link identity to your account", purpose: "record the piece in FolderRegistry under your storage account", cost: "free signature; the sponsor pays gas" },
} as const;
export type IdentityIntent = { title: string; purpose: string; cost: string };

/** A save needs a step this library will not take (deposit, payment approval, dataset creation). */
export class IdentityBlocked extends Error {
  override name = "IdentityBlocked";
  constructor(message: string, readonly setupUrl = "../") {
    super(message);
  }
}

/** Piece store (fil-folders `createSynapseStorage(...)` satisfies it). */
export interface PieceWriter {
  /** `metadata` is Synapse piece metadata (Filecoin Drive conventions: label, path, ipfsRootCID). */
  put(data: Uint8Array, options?: { metadata?: Record<string, string> }): Promise<{ pieceCid: string }>;
}

/** Folder Filecoin Drive / TreFolders show TrePerson pieces under. */
export const IDENTITY_DRIVE_FOLDER = "TrePerson";

/** Filecoin Drive-style piece metadata (public: names no secrets). Version lives on the registry, not as a fourth metadata key. */
export function identityPieceMetadata(fileName: string, _version?: bigint): Record<string, string> {
  return { label: fileName, path: IDENTITY_DRIVE_FOLDER };
}
/** FolderRegistry client (fil-folders `createViemRegistry(...)` satisfies it). */
export interface PointerRegistry {
  head(owner: Address, ns: Hex, key: Hex): Promise<{ pieceCid: Uint8Array; version: bigint }>;
  commit(input: { owner: Address; ns: Hex; key: Hex; pieceCid: Uint8Array; prevPieceCid: Uint8Array }): Promise<{ pieceCid: Uint8Array; version: bigint; txHash?: string }>;
}

export interface SaveIdentityOptions {
  storage: PieceWriter;
  registry: PointerRegistry;
  /** Run `fn` with the wallet prompt labeled (TreFolders `withWalletIntent`). */
  withIntent?: <T>(intent: IdentityIntent, fn: () => Promise<T>) => Promise<T>;
  onStep?: (step: string) => void;
  /** Registry key; default profile. Contacts use {@link IDENTITY_CONTACTS_KEY_ID}. */
  key?: Hex;
  /** File name shown in Filecoin Drive / TreFolders. Default "profile.json" for the profile key. */
  fileName?: string;
  /** Pause before the single CAS-conflict retry (default 1.5 s). */
  retryDelayMs?: number;
  /** Wallet prompts; defaults to IDENTITY_INTENTS (FIL gas). Sponsored saves pass IDENTITY_INTENTS_SPONSORED. */
  intents?: { upload: IdentityIntent; pointer: IdentityIntent };
}

export interface IdentitySaved {
  pieceCid: string;
  version: string;
  txHash?: string;
}

/** fil-folders' RegistryCasConflict (matched by name/message so treperson stays dependency-free) or the contract's CasConflict revert. */
export function isCasConflict(error: unknown): boolean {
  const e = error as { name?: string; message?: string; shortMessage?: string } | null;
  return !!e && (e.name === "RegistryCasConflict" || /CasConflict|compare-and-swap conflict/i.test(`${e.message ?? ""} ${e.shortMessage ?? ""}`));
}

/** Store `bytes` as a piece and CAS-commit the pointer `(owner, fil-identity, key)` to it. */
export async function savePointedPiece(owner: Address, bytes: Uint8Array, opts: SaveIdentityOptions): Promise<IdentitySaved> {
  const run = opts.withIntent ?? (<T>(_: IdentityIntent, fn: () => Promise<T>) => fn());
  const intents = opts.intents ?? IDENTITY_INTENTS;
  opts.onStep?.("Storing your identity piece…");
  const key0 = opts.key ?? IDENTITY_PROFILE_KEY_ID;
  const before = await opts.registry.head(owner, IDENTITY_NS, key0).catch(() => null);
  const metadata = identityPieceMetadata(opts.fileName ?? (key0 === IDENTITY_PROFILE_KEY_ID ? "profile.json" : "record.json"), (before?.version ?? 0n) + 1n);
  const { pieceCid } = await run(intents.upload, () => opts.storage.put(bytes, { metadata }));
  opts.onStep?.("Linking it to your account…");
  const key = opts.key ?? IDENTITY_PROFILE_KEY_ID;
  // Re-read the head right before committing; a lagging RPC or an overlapping save can still hand back a
  // stale version, so on a CAS conflict re-read once more (after a short pause) and retry a single time.
  const commitOnce = async () => {
    const head = await opts.registry.head(owner, IDENTITY_NS, key);
    return run(intents.pointer, () =>
      opts.registry.commit({ owner, ns: IDENTITY_NS, key, pieceCid: new TextEncoder().encode(pieceCid), prevPieceCid: head.pieceCid }),
    );
  };
  let record: Awaited<ReturnType<typeof commitOnce>>;
  try {
    record = await commitOnce();
  } catch (error) {
    if (!isCasConflict(error)) throw error;
    opts.onStep?.("Your identity changed meanwhile — linking to the latest version…");
    await new Promise((resolve) => setTimeout(resolve, opts.retryDelayMs ?? 1500));
    record = await commitOnce();
  }
  return { pieceCid: new TextDecoder().decode(record.pieceCid), version: record.version.toString(), txHash: record.txHash };
}

/** Save a profile: validate owner match, encode, store, point. */
export async function saveIdentity(identity: IdentityV1, opts: SaveIdentityOptions): Promise<IdentitySaved> {
  // History lives in the pieces: each profile names the piece it replaces (no chain log scan needed).
  const head = await opts.registry.head(identity.address, IDENTITY_NS, IDENTITY_PROFILE_KEY_ID).catch(() => null);
  const prev = head ? new TextDecoder().decode(head.pieceCid) : "";
  return savePointedPiece(identity.address, encodeIdentity({ ...identity, prev }), { ...opts, key: IDENTITY_PROFILE_KEY_ID });
}

/** Payment/dataset gate before a Synapse upload. Never approves or deposits. */
export function assertStorageReady(state: { funds: bigint; approved: boolean; datasetId: bigint | null }): void {
  if (!(state.funds > 0n) || !state.approved) throw new IdentityBlocked("Storage payments are not set up for this wallet. Finish setup in TreFolders (it shows the cost first), then save again.");
  if (state.datasetId == null) throw new IdentityBlocked("This wallet has no storage dataset yet. Create one in TreFolders (it shows the cost first), then save again.");
}

/** Address book (planned): `{ v:1, schema:"fil-identity/contacts", address, contacts:[{address,label,note?}], updatedAt }` at key "contacts". */
export interface ContactsV1 {
  v: 1;
  schema: "fil-identity/contacts";
  address: Address;
  contacts: { address: Address; label: string; note?: string }[];
  updatedAt: string;
}
export { IDENTITY_CONTACTS_KEY_ID };
