import type { Address, Hex } from "viem";
import type { ClubView, RemovalBlob } from "./core.js";

/** Everything /ficlub/ needs from wallet + chain. Mock (in-memory) and live (viem + FiClub contract) implement it. */
export interface ClubIO {
  /** "mock" when no FiClub contract address is configured. */
  mode: "mock" | "live";
  chainId: number;
  contract: Address;
  connect(): Promise<Address>;
  peek(): Promise<Address | null>;
  listClubs(me: Address): Promise<ClubView[]>;
  getClub(id: bigint): Promise<ClubView>;
  createClub(name: string): Promise<bigint>;
  addMember(id: bigint, who: Address): Promise<void>;
  removeMember(id: bigint, who: Address): Promise<void>;
  addAdmin(id: bigint, who: Address): Promise<void>;
  removeAdmin(id: bigint, who: Address): Promise<void>;
  /** Step 1/2: EIP-712 RemoveAdmin signature by the connected admin. Free. */
  signRemoval(me: Address, club: ClubView, target: Address, deadline: bigint, step: 1 | 2): Promise<Hex>;
  /** Submit removeAdminWithSignatures with both signatures (gas). */
  submitRemoval(blob: RemovalBlob, sig2: Hex): Promise<void>;
}

/** Labeled costs shown in every wallet toast (estimates on Calibration). */
export const CLUB_INTENTS = {
  create: { title: "Create club", purpose: "you become its first admin and member", cost: "gas ~0.02 FIL" },
  addMember: { title: "Add member", cost: "gas ~0.01 FIL" },
  removeMember: { title: "Remove member", cost: "gas ~0.01 FIL" },
  addAdmin: { title: "Add admin", cost: "gas ~0.01 FIL" },
  removeAdmin: { title: "Remove admin", cost: "gas ~0.01 FIL" },
  sign1: { title: "Sign admin removal (step 1 of 2)", purpose: "a second admin must co-sign", cost: "free signature" },
  sign2: { title: "Co-sign admin removal (step 2 of 2)", cost: "free signature" },
  submit: { title: "Submit admin removal", purpose: "send both signatures on chain", cost: "gas ~0.01 FIL" },
} as const;
