import type { IdentitySaved, IdentityV1, ResolvedIdentity } from "fiperson/edit";
export { IDENTITY_INTENTS, IdentityBlocked } from "fiperson/edit";
export type { IdentitySaved };

/** Everything the /identity/ page needs from wallet, chain and storage. */
export interface IdentityIO {
  peek(): Promise<string | null>;
  connect(): Promise<string>;
  load(address: string): Promise<ResolvedIdentity>;
  save(address: string, identity: IdentityV1, onStep: (step: string) => void): Promise<IdentitySaved>;
}
