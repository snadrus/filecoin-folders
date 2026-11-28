// Ops: return unspent Filecoin Pay funds from sponsor-owned LockedSignerAccounts to the treasury (admin `sweep`).
//   SPONSOR_KEY=0x… tsx apps/trefolders/sponsor/sweep.ts 0xAccount…
import { erc20Abi, formatUnits, type Address, type Hex } from "viem";
import { CHAIN, NETWORK, SponsorWalletRelayer, publicClient } from "./relayer.js";
import { explorerTx, sweepAccount } from "./sweeplib.js";

const pub = publicClient();
const relayer = new SponsorWalletRelayer(process.env.SPONSOR_KEY as Hex);
const USDFC = (CHAIN.contracts as unknown as Record<string, { address: Address }>).usdfc!.address;

for (const account of process.argv.slice(2) as Address[]) {
  const r = await sweepAccount(pub, relayer, account, NETWORK);
  const line = `${account} funds ${r.funds} lockup ${r.lockup}`;
  console.log(r.hash ? `${line} swept ${r.swept} ${explorerTx(NETWORK, r.hash)}` : `${line} ${r.outcome}`);
}
const usdfc = await pub.readContract({ address: USDFC, abi: erc20Abi, functionName: "balanceOf", args: [relayer.address] });
console.log(`sponsor ${relayer.address} USDFC ${formatUnits(usdfc, 18)} tFIL ${formatUnits(await pub.getBalance({ address: relayer.address }), 18)}`);
