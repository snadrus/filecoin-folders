import type { ChainReport } from "./chain-step.js";
import type { ChainChoice, Session } from "./session.js";
import type { WalletPanel } from "./onboarding-logic.js";

export type ChainReporter = (report: ChainReport) => void;

export interface OnboardingIO {
  discover(): Promise<{ rdns: string; name: string }[]>;
  connect(input: { rdns: string | null; chain: ChainChoice }): Promise<void>;
  /** Restore the permitted account without `eth_requestAccounts`. */
  silent(chain: ChainChoice): Promise<boolean>;
  snapshot(input: { chain: ChainChoice; volumeName: string }): Promise<WalletPanel>;
  authorize(chain: ChainChoice, force?: boolean, report?: ChainReporter): Promise<void>;
  fixPayments(chain: ChainChoice, report?: ChainReporter, force?: boolean): Promise<void>;
  createDataset(input: { chain: ChainChoice; volumeName: string }): Promise<void>;
  selectDataset(id: string, chain: ChainChoice): void;
  enter(input: { chain: ChainChoice; volumeName: string; encrypt: boolean }): Promise<Session>;
  disconnect(): void;
}
