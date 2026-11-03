import type { IdentityV1, ResolvedIdentity } from "fil-folders";

/** Why a save cannot go ahead without a step Andy/the user has not taken yet. */
export class IdentityBlocked extends Error {
  override name = "IdentityBlocked";
  constructor(message: string, readonly setupUrl = "../") {
    super(message);
  }
}

export interface IdentitySaved {
  pieceCid: string;
  version: string;
  txHash?: string;
}

/** Everything the /identity/ page needs from wallet, chain and storage. */
export interface IdentityIO {
  /** Already-permitted account, without a prompt. */
  peek(): Promise<string | null>;
  connect(): Promise<string>;
  load(address: string): Promise<ResolvedIdentity>;
  save(address: string, identity: IdentityV1, onStep: (step: string) => void): Promise<IdentitySaved>;
}

/** Wallet prompts the page raises, named with what they do and what they cost. */
export const IDENTITY_INTENTS = {
  upload: { title: "Store identity piece", purpose: "sign the add-piece request for your existing storage dataset", cost: "free signature; a few bytes billed from your storage deposit" },
  pointer: { title: "Link identity to wallet", purpose: "record the piece in FolderRegistry under your address", cost: "gas ~0.01 FIL" },
} as const;
