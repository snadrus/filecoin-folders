export type ChainFlow = "session" | "payment";
export type ChainPhase = "signing" | "submitted" | "confirming" | "done";

export interface ChainReport {
  flow: ChainFlow;
  phase: ChainPhase;
  hash?: string;
  blocks?: number;
  elapsedSec?: number;
}

export interface ChainStepView {
  id: string;
  title: string;
  detail: string;
  href: string;
  phase: ChainPhase;
}

const TITLES: Record<ChainPhase, string> = {
  signing: "Waiting for wallet signature",
  submitted: "Transaction submitted",
  confirming: "Confirming",
  done: "Authorized",
};

export function chainStepTitle(report: ChainReport): string {
  if (report.phase === "done" && report.flow === "payment") return "Payment enabled";
  return TITLES[report.phase];
}

export function explorerHref(chain: "calibration" | "mainnet", hash: string): string {
  const host = chain === "mainnet" ? "https://filfox.info" : "https://calibration.filfox.info";
  return `${host}/en/message/${hash}`;
}

export function stepDetail(report: ChainReport): string {
  if (report.phase === "confirming") {
    const blocks = report.blocks ?? 0;
    const elapsed = report.elapsedSec ?? 0;
    return `${blocks} ${blocks === 1 ? "block" : "blocks"} · ${elapsed}s`;
  }
  return "";
}
