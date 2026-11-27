// Deploy LockedSignerAccountBeaconFactory (v2): BeaconProxy accounts, UpgradeableBeacon owned by the sponsor.
// Hand the beacon to Andy's Ledger 0x later with: recover.ts --factory <this> --hand-beacon 0x… --yes
// Do not set the beacon owner to the f1 masked-ID recovery address; it cannot sign EVM upgrades.
//   forge build --root contracts
//   SPONSOR_KEY=0x… tsx apps/fifolders/sponsor/deploy-v2.ts
// Mainnet: only run if the sponsor wallet has enough FIL for deploy gas on top of the operating floor (see --estimate).
import { readFileSync, writeFileSync } from "node:fs";
import { encodeDeployData, formatEther, formatUnits, getAddress, parseAbi, type Address, type Hex } from "viem";
import { CALIBRATION_REGISTRY_V2, MAINNET_REGISTRY_V2 } from "fil-folders";
import { CHAIN, NETWORK, SponsorWalletRelayer, publicClient } from "./relayer.js";

const artifact = JSON.parse(readFileSync(new URL("../../../contracts/out/LockedSignerAccountV2.sol/LockedSignerAccountBeaconFactory.json", import.meta.url), "utf8"));
const estimateOnly = process.argv.includes("--estimate");
const key = process.env.SPONSOR_KEY as Hex | undefined;
if (!key && !estimateOnly) throw new Error("Set SPONSOR_KEY");
const relayer = key ? new SponsorWalletRelayer(key) : null;
const pub = publicClient({ network: NETWORK });
const fwss = getAddress((CHAIN.contracts as unknown as { fwss: { address: Address } }).fwss.address);
const registry = getAddress(process.env.SPONSOR_REGISTRY ?? (NETWORK === "calibration" ? CALIBRATION_REGISTRY_V2 : MAINNET_REGISTRY_V2));
const legacyFactory = getAddress(process.env.SPONSOR_FACTORY_LEGACY ?? (NETWORK === "calibration" ? "0xCBb99E41C173B06D15212A135ba9F46AAB19DEE5" : "0xaaA1795A150BA01F7A5894A3D1A95334B695F067"));
const factoryView = parseAbi(["function admin() view returns (address)", "function treasury() view returns (address)"]);
const legacyAdmin = await pub.readContract({ address: legacyFactory, abi: factoryView, functionName: "admin" }).catch(() => undefined) as Address | undefined;
const legacyTreasury = await pub.readContract({ address: legacyFactory, abi: factoryView, functionName: "treasury" }).catch(() => undefined) as Address | undefined;
const admin = relayer?.address ?? (process.env.SPONSOR_ADMIN ? getAddress(process.env.SPONSOR_ADMIN) : legacyAdmin) ?? getAddress("0xa69A4eF204eA951976bd6bDaCbd932Bbd18B08Db");
const treasury = getAddress(process.env.SPONSOR_TREASURY ?? legacyTreasury ?? (NETWORK === "mainnet" ? "0xFf00000000000000000000000000000000399a90" : admin));
const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [fwss, registry, admin, treasury] });

const gas = await pub.estimateGas({ account: admin, data } as never);
const fees = await pub.estimateFeesPerGas();
const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
const cost = (gas * 13n) / 10n * maxFee;
const balance = await pub.getBalance({ address: admin });
const floor = process.env.SPONSOR_GAS_FIL_FLOOR_FIL ? BigInt(Math.round(Number(process.env.SPONSOR_GAS_FIL_FLOOR_FIL) * 1e18)) : 10n ** 16n * 5n; // 0.05 FIL default
const report = {
  contract: "LockedSignerAccountBeaconFactory",
  network: NETWORK,
  estimatedGas: gas.toString(),
  maxFeePerGas: maxFee.toString(),
  estimatedCostWei: cost.toString(),
  estimatedCostFil: formatUnits(cost, 18),
  sponsorFil: formatEther(balance),
  floorFil: formatUnits(floor, 18),
  enough: balance >= cost + floor,
};

if (estimateOnly || !relayer) {
  console.log(JSON.stringify({ ...report, admin, treasury, registry, fwss }, null, 2));
  process.exit(report.enough ? 0 : 2);
}

if (NETWORK === "mainnet" && !report.enough) {
  console.log(JSON.stringify({ ...report, error: "mainnet sponsor does not have enough FIL for deploy plus the operating floor; not sending" }, null, 2));
  process.exit(2);
}

const deployed = await relayer.relay({ label: "deploy LockedSignerAccountBeaconFactory", data });
const address = getAddress(deployed.contractAddress!);
const [beacon, implementation] = await Promise.all([
  pub.readContract({ address, abi: artifact.abi, functionName: "beacon" }) as Promise<Address>,
  pub.readContract({ address, abi: artifact.abi, functionName: "implementation" }) as Promise<Address>,
]);
const out = {
  network: NETWORK,
  chainId: NETWORK === "mainnet" ? 314 : 314159,
  contract: "LockedSignerAccountBeaconFactory",
  address,
  beacon,
  implementation,
  admin,
  treasury,
  treasuryNote: "unchanged from v1: may be the recovery masked-ID; the beacon owner is the sponsor and is handed to a Ledger 0x later",
  registry,
  fwss,
  txHash: deployed.transactionHash,
  block: Number(deployed.blockNumber),
  gasUsed: Number(deployed.gasUsed),
  date: new Date().toISOString().slice(0, 10),
};
const dest = new URL(`../../../deployments/${NETWORK === "mainnet" ? "mainnet" : "calibration"}-factory-v2.json`, import.meta.url);
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
