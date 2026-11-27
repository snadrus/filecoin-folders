// Ops: send everything the sponsor wallet holds back to the operator. Dry run unless --yes.
//   SPONSOR_NETWORK=mainnet SPONSOR_KEY_FILE=/path/to/key RECOVERY_ADDRESS=f1… [RECOVERY_USDFC_ADDRESS=0x…] \
//     tsx apps/fifolders/sponsor/recover.ts [--factory 0x…] [--sweep 0xA,0xB] [--hand-admin] [--yes]
//   Hand the v2 UpgradeableBeacon to Andy's Ledger 0x (dry run unless --yes):
//     SPONSOR_KEY_FILE=/path/to/key tsx apps/fifolders/sponsor/recover.ts --factory 0x… --hand-beacon 0xLedger [--yes]
// RECOVERY_ADDRESS gets the FIL (all of it minus the final send's gas). RECOVERY_USDFC_ADDRESS (default: same) gets all
// USDFC. --factory points the factory treasury at RECOVERY_USDFC_ADDRESS first, so --sweep (pooled/terminated
// accounts) and any later admin sweep land there. --hand-admin also makes RECOVERY_USDFC_ADDRESS the factory admin
// (only if it is a 0x key-holder that can sign EVM txs). Stop the Worker's pool first (SPONSOR_POOL_SIZE_MAINNET=0)
// so it does not spend while you drain. The key is read from SPONSOR_KEY or SPONSOR_KEY_FILE and never printed.
import { readFileSync } from "node:fs";
import { createPublicClient, formatUnits, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { chainFor, rpcFor, type SponsorNetwork } from "./relayer.js";
import { evmRecoveryChain } from "./recover-chain.js";
import { factoryBeaconAbi, beaconAbi, handBeaconOwnership, lotusLookupId, maskedIdOf, recoverAll, resolveRecipient } from "./recoverlib.js";
import { explorerTx } from "./sweeplib.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const network: SponsorNetwork = process.env.SPONSOR_NETWORK === "mainnet" ? "mainnet" : "calibration";
const key = (process.env.SPONSOR_KEY ?? (process.env.SPONSOR_KEY_FILE ? readFileSync(process.env.SPONSOR_KEY_FILE, "utf8") : "")).trim() as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("set SPONSOR_KEY or SPONSOR_KEY_FILE (a 0x-prefixed 32-byte hex key)");
const handBeaconTo = opt("hand-beacon");
if (handBeaconTo) {
  if (!isAddress(handBeaconTo)) throw new Error("--hand-beacon needs a 0x Ethereum address (Andy's Ledger). The f1 masked-ID cannot own the beacon.");
  const factory = opt("factory") ? getAddress(opt("factory")!) : undefined;
  if (!factory) throw new Error("--hand-beacon needs --factory 0x… (the v2 beacon factory)");
  const rpc = rpcFor(network, process.env.SPONSOR_RPC);
  const chain = evmRecoveryChain({ key, network, rpc });
  const pub = createPublicClient({ transport: http(rpc) });
  const dryRun = !flag("yes");
  console.log(`${dryRun ? "DRY RUN (add --yes to send)" : "SENDING"} on ${network} from ${chain.address}`);
  const report = await handBeaconOwnership(
    {
      address: chain.address,
      send: chain.send,
      readBeacon: (f) => pub.readContract({ address: f, abi: factoryBeaconAbi, functionName: "beacon" }) as Promise<typeof factory>,
      readBeaconOwner: (b) => pub.readContract({ address: b, abi: beaconAbi, functionName: "owner" }) as Promise<typeof factory>,
    },
    { factory, newOwner: getAddress(handBeaconTo), dryRun, log: (line) => console.log(`  ${line}`) },
  );
  if (report.hash) console.log(`  beacon: ${explorerTx(network, report.hash)}`);
  process.exit(0);
}
if (!process.env.RECOVERY_ADDRESS) throw new Error("set RECOVERY_ADDRESS");
const rpc = rpcFor(network, process.env.SPONSOR_RPC);
const lookup = lotusLookupId(rpc);
const filTo = await resolveRecipient(process.env.RECOVERY_ADDRESS, network, lookup);
const usdfcTo = await resolveRecipient(process.env.RECOVERY_USDFC_ADDRESS ?? process.env.RECOVERY_ADDRESS, network, lookup);
const contracts = chainFor(network).contracts as unknown as Record<string, { address: Address }>;
const usdfc = getAddress(contracts.usdfc!.address);
const factory = opt("factory") ? getAddress(opt("factory")!) : undefined;
const sweep = (opt("sweep") ?? "").split(",").filter(Boolean).map((a) => getAddress(a));
if (flag("hand-admin") && maskedIdOf(usdfcTo) !== undefined) throw new Error("--hand-admin needs a 0x RECOVERY_USDFC_ADDRESS that can sign EVM transactions");

const chain = evmRecoveryChain({ key, network, rpc });

const dryRun = !flag("yes");
console.log(`${dryRun ? "DRY RUN (add --yes to send)" : "SENDING"} on ${network} from ${chain.address}`);
console.log(`FIL → ${filTo}${process.env.RECOVERY_ADDRESS !== filTo ? ` (${process.env.RECOVERY_ADDRESS})` : ""}; USDFC → ${usdfcTo}`);
const report = await recoverAll(chain, { filTo, usdfcTo, usdfc, factory, sweep, newAdmin: flag("hand-admin") ? usdfcTo : undefined, dryRun, log: (line) => console.log(`  ${line}`) });
for (const s of report.steps) if (s.hash) console.log(`  ${s.step}: ${explorerTx(network, s.hash)}`);
console.log(`FIL ${formatUnits(report.fil.before, 18)} → sent ${formatUnits(report.fil.sent, 18)}${report.fil.after !== undefined ? `, left ${formatUnits(report.fil.after, 18)}` : ""}`);
console.log(`USDFC ${formatUnits(report.usdfc.before, 18)} → sent ${formatUnits(report.usdfc.sent, 18)}${report.usdfc.after !== undefined ? `, left ${formatUnits(report.usdfc.after, 18)}` : ""}`);
