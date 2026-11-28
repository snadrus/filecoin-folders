// Calibration-only: deploy a new LockedSignerAccountV2 implementation and point the existing beacon at it.
// Factory ABI is unchanged. Never prints the sponsor key. Refuses mainnet.
//   forge build --root contracts
//   SPONSOR_KEY=0x… SPONSOR_NETWORK=calibration tsx apps/trefolders/sponsor/upgrade-beacon.ts
import { readFileSync, writeFileSync } from "node:fs";
import { encodeDeployData, encodeFunctionData, formatEther, getAddress, parseAbi, type Address, type Hex } from "viem";
import { NETWORK, SponsorWalletRelayer, publicClient } from "./relayer.js";

if (NETWORK !== "calibration") {
  console.error("upgrade-beacon is Calibration-only; refusing network=" + NETWORK);
  process.exit(1);
}

const key = process.env.SPONSOR_KEY as Hex | undefined;
if (!key) throw new Error("Set SPONSOR_KEY");

const factoryAddr = getAddress(process.env.SPONSOR_FACTORY ?? "0x228867301f1f0EaF75b5d7af62F3c44e1796A56D");
const implArtifact = JSON.parse(readFileSync(new URL("../../../contracts/out/LockedSignerAccountV2.sol/LockedSignerAccountV2.json", import.meta.url), "utf8"));
const beaconAbi = parseAbi([
  "function implementation() view returns (address)",
  "function owner() view returns (address)",
  "function upgradeTo(address newImplementation)",
]);
const factoryAbi = parseAbi(["function beacon() view returns (address)", "function implementation() view returns (address)", "function admin() view returns (address)"]);

const relayer = new SponsorWalletRelayer(key);
const pub = publicClient({ network: "calibration" });
const beacon = getAddress((await pub.readContract({ address: factoryAddr, abi: factoryAbi, functionName: "beacon" })) as Address);
const current = getAddress((await pub.readContract({ address: factoryAddr, abi: factoryAbi, functionName: "implementation" })) as Address);
const owner = getAddress((await pub.readContract({ address: beacon, abi: beaconAbi, functionName: "owner" })) as Address);
if (owner.toLowerCase() !== relayer.address.toLowerCase()) {
  throw new Error(`beacon owner ${owner} is not the sponsor wallet; not sending an upgrade. After the Ledger handover, follow docs/beacon-upgrade.md (upgradeTo signed by 0xD62bD538bcEaB1284950E513f6Da796dD790642a)`);
}

const data = encodeDeployData({ abi: implArtifact.abi, bytecode: implArtifact.bytecode.object, args: [factoryAddr] });
const deploy = await relayer.relay({ label: "deploy LockedSignerAccountV2 implementation", data });
const implementation = getAddress(deploy.contractAddress!);
if (implementation.toLowerCase() === current.toLowerCase()) {
  throw new Error("new implementation address matches the current one; aborting");
}
const upgraded = await relayer.relay({ to: beacon, label: `beacon.upgradeTo ${implementation}`, data: encodeFunctionData({ abi: beaconAbi, functionName: "upgradeTo", args: [implementation] }) });
// Filecoin RPCs can lag one head read after inclusion; poll until the beacon reports the new implementation.
let live = current;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  live = getAddress((await pub.readContract({ address: beacon, abi: beaconAbi, functionName: "implementation" })) as Address);
  if (live.toLowerCase() === implementation.toLowerCase()) break;
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}
if (live.toLowerCase() !== implementation.toLowerCase()) throw new Error(`beacon still points at ${live}`);

const dest = new URL("../../../deployments/calibration-factory-v2.json", import.meta.url);
const prev = JSON.parse(readFileSync(dest, "utf8")) as Record<string, unknown>;
const out = {
  ...prev,
  implementation,
  previousImplementation: current,
  upgradeTx: upgraded.transactionHash,
  deployTx: deploy.transactionHash,
  upgradeBlock: Number(upgraded.blockNumber),
  upgradeDate: new Date().toISOString().slice(0, 10),
  sponsorFil: formatEther(await pub.getBalance({ address: relayer.address })),
};
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ factory: factoryAddr, beacon, previousImplementation: current, implementation, deployTx: deploy.transactionHash, upgradeTx: upgraded.transactionHash, upgradeBlock: Number(upgraded.blockNumber) }, null, 2));
