import type { ChainReport } from "./chain-step.js";
import type { ChainChoice, Session } from "./session.js";
import type { SessionGate, WalletPanel } from "./onboarding-logic.js";

export type ChainReporter = (report: ChainReport) => void;

export interface OnboardingIO {
  discover(): Promise<{ rdns: string; name: string }[]>;
  connect(input: { rdns: string | null; chain: ChainChoice }): Promise<void>;
  /** Restore the permitted account without `eth_requestAccounts`. */
  silent(chain: ChainChoice): Promise<boolean>;
  /** Wallet switched account (address), disconnected (""), or changed chain (chainId). Never prompts. */
  onWalletChange?(fn: (change: { account?: string; chainId?: string }) => void): void;
  snapshot(input: { chain: ChainChoice; volumeName: string }): Promise<WalletPanel>;
  authorize(chain: ChainChoice, force?: boolean, report?: ChainReporter): Promise<void>;
  /**
   * On-chain authorization for every FiFolders permission.
   * `expired` is inside the safety margin or missing. `soon` is under one day.
   */
  sessionGate(chain: ChainChoice): Promise<SessionGate>;
  fixPayments(chain: ChainChoice, report?: ChainReporter, force?: boolean): Promise<void>;
  createDataset(input: { chain: ChainChoice; volumeName: string }): Promise<void>;
  selectDataset(id: string, chain: ChainChoice): void;
  enter(input: { chain: ChainChoice; volumeName: string; encrypt: boolean }): Promise<Session>;
  /**
   * Rebuild chain clients after `loginAndFund`.
   * Returns null when the open volume must stay (in-memory mock storage).
   */
  reopen(input: { chain: ChainChoice; volumeName: string; encrypt: boolean }): Promise<Session | null>;
  /**
   * Public, signature-free read of the preferred dataset's volume (folders are public).
   * Null when unknown, encrypted or not yet created. Writes on it are never attempted.
   */
  peek?(input: { chain: ChainChoice; volumeName: string; owner?: string }): Promise<Session | null>;
  disconnect(): void;
}
