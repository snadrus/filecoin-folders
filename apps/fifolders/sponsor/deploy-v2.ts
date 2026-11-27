// Deploy LockedSignerAccountBeaconFactory (v2): BeaconProxy accounts, UpgradeableBeacon initially owned by the sponsor.
// On mainnet (and on Calibration when an intended owner is configured), transfer beacon ownership to Andy's Ledger
// immediately after deploy. Address: deployments/beacon-owner.json (or BEACON_OWNER / SPONSOR_BEACON_OWNER).
// Do not set the beacon owner to the f1 masked-ID recovery address; it cannot sign EVM upgrades.
//   forge build --root contracts
//   SPONSOR_KEY=0x… tsx apps/fifolders/sponsor/deploy-v2.ts
// Mainnet: only run if the sponsor wallet has enough FIL for deploy gas on top of the operating floor (see --estimate).
import { readFileSync, writeFileSync } from "node:fs";
import { encodeDeployData, formatEther, formatUnits, getAddress, parseAbi, type Address, type Hex } from "viem";
import { beaconAbi, handBeaconOwnership } from "./recoverlib.js";
import { CALIBRATION_REGISTRY_V2, MAINNET_REGISTRY_V2 } from "fil-folders";
import { CHAIN, NETWORK, SponsorWalletRelayer, publicClient } from "./relayer.js";

function intendedBeaconOwner(): Address | undefined {
  const fromEnv = process.env.BEACON_OWNER ?? process.env.SPONSOR_BEACON_OWNER;
  if (fromEnv) {
    const owner = getAddress(fromEnv);
    if (owner.toLowerCase().startsWith("0xff" + "00".repeat(11))) throw new Error("BEACON_OWNER must be a 0x EOA that can sign EVM upgrades (not an f1 masked-ID)");
    return owner;
  }
  try {
    const file = JSON.parse(readFileSync(new URL("../../../deployments/beacon-owner.json", import.meta.url), "utf8")) as { intendedBeaconOwner?: string };
    if (!file.intendedBeaconOwner) return undefined;
    const owner = getAddress(file.intendedBeaconOwner);
    if (owner.toLowerCase().startsWith("0xff" + "00".repeat(11))) throw new Error("intendedBeaconOwner must be a 0x EOA that can sign EVM upgrades (not an f1 masked-ID)");
    return owner;
  } catch (error) {
    if (error instanceof Error && /must be a 0x EOA/.test(error.message)) throw error;
    return undefined;
  }
}

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

const beaconOwner = intendedBeaconOwner();

if (estimateOnly || !relayer) {
  console.log(JSON.stringify({ ...report, admin, treasury, registry, fwss, intendedBeaconOwner: beaconOwner }, null, 2));
  process.exit(report.enough ? 0 : 2);
}

if (NETWORK === "mainnet" && !beaconOwner) {
  console.log(JSON.stringify({ ...report, error: "mainnet v2 deploy needs BEACON_OWNER or deployments/beacon-owner.json so the beacon can be handed to Andy's Ledger right after deploy" }, null, 2));
  process.exit(2);
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
  registry,
  fwss,
  txHash: deployed.transactionHash,
  block: Number(deployed.blockNumber),
  gasUsed: Number(deployed.gasUsed),
  date: new Date().toISOString().slice(0, 10),
  intendedBeaconOwner: beaconOwner,
  treasuryNote: beaconOwner
    ? `treasury may be the recovery masked-ID; beacon ownership is transferred to Andy's Ledger ${beaconOwner} immediately after deploy (not the f1 masked-ID)`
    : "unchanged from v1: may be the recovery masked-ID; the beacon owner is the sponsor and is handed to a Ledger 0x later",
} as Record<string, unknown>;
if (beaconOwner && beaconOwner.toLowerCase() !== relayer.address.toLowerCase()) {
  const hand = await handBeaconOwnership(
    {
      address: relayer.address,
      send: async (call) => {
        const receipt = await relayer.relay({ to: call.to, data: call.data, label: call.label ?? "transferBeaconOwnership" });
        return receipt.transactionHash;
      },
      readBeacon: async () => beacon,
      readBeaconOwner: async (b) => getAddress((await pub.readContract({ address: b, abi: beaconAbi, functionName: "owner" })) as Address),
    },
    { factory: address, newOwner: beaconOwner, dryRun: false },
  );
  const liveDeadline = Date.now() + 120_000;
  let live = getAddress((await pub.readContract({ address: beacon, abi: beaconAbi, functionName: "owner" })) as Address);
  while (live.toLowerCase() !== beaconOwner.toLowerCase() && Date.now() < liveDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    live = getAddress((await pub.readContract({ address: beacon, abi: beaconAbi, functionName: "owner" })) as Address);
  }
  if (live.toLowerCase() !== beaconOwner.toLowerCase()) throw new Error(`beacon owner is still ${live}, expected ${beaconOwner}`);
  out.beaconOwner = live;
  if (hand.hash) out.handBeaconTx = hand.hash;
}
const dest = new URL(`../../../deployments/${NETWORK === "mainnet" ? "mainnet" : "calibration"}-factory-v2.json`, import.meta.url);
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
