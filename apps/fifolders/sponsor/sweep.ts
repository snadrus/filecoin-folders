// Ops: return unspent Filecoin Pay funds from sponsor-owned LockedSignerAccounts to the treasury (admin `sweep`).
//   SPONSOR_KEY=0x… tsx apps/fifolders/sponsor/sweep.ts 0xAccount…
import { encodeFunctionData, erc20Abi, formatUnits, parseAbi, type Address, type Hex } from "viem";
import { CHAIN, SponsorWalletRelayer, publicClient } from "./relayer.js";

const pub = publicClient();
const relayer = new SponsorWalletRelayer(process.env.SPONSOR_KEY as Hex);
const contracts = CHAIN.contracts as unknown as Record<string, { address: Address }>;
const USDFC = contracts.usdfc!.address;
const PAY = contracts.filecoinPay!.address;
const payAbi = parseAbi(["function accounts(address token, address owner) view returns (uint256 funds, uint256 lockupCurrent, uint256 lockupRate, uint256 lockupLastSettledAt)"]);
const acctAbi = parseAbi(["function sweep(uint256 amount)", "function FACTORY() view returns (address)"]);
const factoryAbi = parseAbi(["function admin() view returns (address)", "function treasury() view returns (address)"]);
const explorer = CHAIN.id === 314 ? "https://filfox.info/en/message/" : "https://calibration.filfox.info/en/message/";

for (const account of process.argv.slice(2) as Address[]) {
  const [funds, lockup] = await pub.readContract({ address: PAY, abi: payAbi, functionName: "accounts", args: [USDFC, account] });
  const line = `${account} funds ${formatUnits(funds, 18)} lockup ${formatUnits(lockup, 18)}`;
  try {
    const factory = await pub.readContract({ address: account, abi: acctAbi, functionName: "FACTORY" });
    const [admin, treasury] = await Promise.all([
      pub.readContract({ address: factory, abi: factoryAbi, functionName: "admin" }),
      pub.readContract({ address: factory, abi: factoryAbi, functionName: "treasury" }),
    ]);
    if (admin !== relayer.address || treasury !== relayer.address) {
      console.log(`${line} skip: admin ${admin} treasury ${treasury}`);
      continue;
    }
  } catch {
    console.log(`${line} skip: not a LockedSignerAccount`);
    continue;
  }
  // Filecoin Pay settles lockup on withdraw; back off until the simulation passes.
  let amount = funds - lockup;
  let done = false;
  for (let attempt = 0; attempt < 8 && amount > 0n; attempt += 1) {
    const data = encodeFunctionData({ abi: acctAbi, functionName: "sweep", args: [amount] });
    try {
      await pub.call({ account: relayer.address, to: account, data });
    } catch {
      amount = (amount * 9n) / 10n;
      continue;
    }
    let receipt;
    try {
      receipt = await relayer.relay({ to: account, data, label: `sweep ${account}` });
    } catch {
      // Lockup can grow between the simulation and the estimate; back off and retry.
      amount = (amount * 9n) / 10n;
      continue;
    }
    console.log(`${line} swept ${formatUnits(amount, 18)} ${explorer}${receipt.transactionHash}`);
    done = true;
    break;
  }
  if (!done) console.log(`${line} nothing sweepable`);
}
const usdfc = await pub.readContract({ address: USDFC, abi: erc20Abi, functionName: "balanceOf", args: [relayer.address] });
console.log(`sponsor ${relayer.address} USDFC ${formatUnits(usdfc, 18)} tFIL ${formatUnits(await pub.getBalance({ address: relayer.address }), 18)}`);
