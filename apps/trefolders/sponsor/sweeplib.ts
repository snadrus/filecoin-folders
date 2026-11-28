// Return unspent Filecoin Pay funds from a sponsor-owned LockedSignerAccount to the treasury (admin `sweep`).
// Shared by the ops CLI (sweep.ts) and the Worker's cron (deferred sweeps).
import { encodeFunctionData, formatUnits, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { chainFor, type Relayer, type SponsorNetwork } from "./relayer.js";

const payAbi = parseAbi(["function accounts(address token, address owner) view returns (uint256 funds, uint256 lockupCurrent, uint256 lockupRate, uint256 lockupLastSettledAt)"]);
const acctAbi = parseAbi(["function sweep(uint256 amount)", "function FACTORY() view returns (address)", "function unassigned() view returns (bool)", "function owner() view returns (address)"]);
const factoryAbi = parseAbi(["function admin() view returns (address)", "function treasury() view returns (address)"]);

export interface SweepResult {
  account: Address;
  funds: string;
  lockup: string;
  /** Where a sweep sends the funds. */
  treasury?: Address;
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
  const base: { account: Address; funds: string; lockup: string; treasury?: Address } = { account, funds: formatUnits(funds, 18), lockup: formatUnits(lockup, 18) };
  try {
    const factory = await pub.readContract({ address: account, abi: acctAbi, functionName: "FACTORY" });
    const [admin, treasury] = await Promise.all([
      pub.readContract({ address: factory, abi: factoryAbi, functionName: "admin" }),
      pub.readContract({ address: factory, abi: factoryAbi, functionName: "treasury" }),
    ]);
    // Funds go to the factory treasury (the sponsor, or the operator's recovery address once set via setTreasury).
    if (admin !== relayer.address) return { ...base, outcome: `skip: admin ${admin} treasury ${treasury}` };
    // Only spare (unassigned) or retired (owned by the sponsor) accounts: never a customer's account (M2/H3).
    const [unassigned, owner] = await Promise.all([
      pub.readContract({ address: account, abi: acctAbi, functionName: "unassigned" }),
      pub.readContract({ address: account, abi: acctAbi, functionName: "owner" }),
    ]);
    if (!unassigned && owner.toLowerCase() !== relayer.address.toLowerCase()) return { ...base, outcome: `skip: assigned to ${owner}` };
    base.treasury = treasury;
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
    } catch (error) {
      // M5: at most one real (gas-paying) attempt per call; the next cron tick retries.
      return { ...base, outcome: `error: sweep relay failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ...base, outcome: "nothing sweepable" };
}
