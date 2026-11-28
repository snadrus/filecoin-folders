import type { IdentitySaved, IdentityV1, ResolvedIdentity } from "treperson/edit";
import type { MyClubs } from "treperson/clubs";
export { IDENTITY_INTENTS, IDENTITY_INTENTS_SPONSORED, IdentityBlocked } from "treperson/edit";
export type { IdentitySaved };

/** Everything the /identity/ page needs from wallet, chain and storage. */
export interface IdentityIO {
  peek(): Promise<string | null>;
  /** Default sign-in: passkey / sponsored session when gasless is on, otherwise the injected wallet. */
  connect(): Promise<string>;
  /** Advanced: injected wallet. In gasless mode this still opens a sponsored session; the id is the payer address. */
  connectWallet?(): Promise<string>;
  /** Use a passkey already on this device or another authenticator. */
  connectPasskey?(kind: "saved" | "new" | "existing"): Promise<string>;
  load(address: string): Promise<ResolvedIdentity>;
  /** "Find all my Clubs": scan TreClub, cache coworkers (treperson/clubs). */
  findClubs(address: string): Promise<MyClubs>;
  save(address: string, identity: IdentityV1, onStep: (step: string) => void): Promise<IdentitySaved>;
  /** UI hints for the connect card and save copy. */
  authMode?(): { sponsored: boolean; passkeyAvailable: boolean; hasSavedPasskey: boolean };
}
