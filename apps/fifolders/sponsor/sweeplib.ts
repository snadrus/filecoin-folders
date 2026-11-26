// Return unspent Filecoin Pay funds from a sponsor-owned LockedSignerAccount to the treasury (admin `sweep`).
// Shared by the ops CLI (sweep.ts) and the Worker's cron (deferred sweeps).
import { encodeFunctionData, formatUnits, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { chainFor, type Relayer, type SponsorNetwork } from "./relayer.js";

const payAbi = parseAbi(["function accounts(address token, address owner) view returns (uint256 funds, uint256 lockupCurrent, uint256 lockupRate, uint256 lockupLastSettledAt)"]);
const acctAbi = parseAbi(["function sweep(uint256 amount)", "function FACTORY() view returns (address)"]);
const factoryAbi = parseAbi(["function admin() view returns (address)", "function treasury() view returns (address)"]);

export interface SweepResult {
  account: Address;
  funds: string;
  lockup: string;
  swept?: string;
  hash?: Hex;
  /** "swept" | "skip: …" | "nothing sweepable" */
  outcome: string;
}

export function explorerTx(network: SponsorNetwork, hash: string): string {
  return `${network === "mainnet" ? "https://filfox.info/en/message/" : "https://calibration.filfox.info/en/message/"}${hash}`;
}

export async function sweepAccount(pub: PublicClient, relayer: Relayer, account: Address, network: SponsorNetwork): Promise<SweepResult> {
  const contracts = chainFor(network).contracts as unknown as Record<string, { address: Address }>;
  const usdfc = contracts.usdfc!.address;
  const pay = contracts.filecoinPay!.address;
  const [funds, lockup] = await pub.readContract({ address: pay, abi: payAbi, functionName: "accounts", args: [usdfc, account] });
  const base = { account, funds: formatUnits(funds, 18), lockup: formatUnits(lockup, 18) };
  try {
    const factory = await pub.readContract({ address: account, abi: acctAbi, functionName: "FACTORY" });
    const [admin, treasury] = await Promise.all([
      pub.readContract({ address: factory, abi: factoryAbi, functionName: "admin" }),
      pub.readContract({ address: factory, abi: factoryAbi, functionName: "treasury" }),
    ]);
    if (admin !== relayer.address || treasury !== relayer.address) return { ...base, outcome: `skip: admin ${admin} treasury ${treasury}` };
  } catch {
    return { ...base, outcome: "skip: not a LockedSignerAccount" };
  }
  // Filecoin Pay settles lockup on withdraw; back off until the simulation (and the relay) pass.
  let amount = funds - lockup;
  for (let attempt = 0; attempt < 8 && amount > 0n; attempt += 1) {
    const data = encodeFunctionData({ abi: acctAbi, functionName: "sweep", args: [amount] });
    try {
      await pub.call({ account: relayer.address, to: account, data });
    } catch {
      amount = (amount * 9n) / 10n;
      continue;
    }
    try {
      const receipt = await relayer.relay({ to: account, data, label: `sweep ${account}` });
      return { ...base, swept: formatUnits(amount, 18), hash: receipt.transactionHash, outcome: "swept" };
    } catch {
      // Lockup can grow between the simulation and the estimate.
      amount = (amount * 9n) / 10n;
    }
  }
  return { ...base, outcome: "nothing sweepable" };
}
