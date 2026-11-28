// Deploy a LockedSignerAccountV3 implementation for an existing v2 beacon factory and print the upgradeTo call the
// beacon owner (Andy's Ledger) must sign. Sends ONE tx (the implementation deploy, from the sponsor key); never touches
// the beacon. Never prints the key.
//   forge build --root contracts
//   SPONSOR_KEY=0x… SPONSOR_NETWORK=calibration|mainnet tsx apps/trefolders/sponsor/deploy-v3-impl.ts
import { readFileSync, writeFileSync } from "node:fs";
import { encodeDeployData, encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { NETWORK, SponsorWalletRelayer, chainFor, publicClient } from "./relayer.js";

const FACTORIES: Record<string, Address> = {
  calibration: "0x228867301f1f0EaF75b5d7af62F3c44e1796A56D",
  mainnet: "0xA06109D9cdA71e1691d910B2DE44839F4723c83e",
};
const LEDGER = getAddress("0xD62bD538bcEaB1284950E513f6Da796dD790642a");

const key = process.env.SPONSOR_KEY as Hex | undefined;
if (!key) throw new Error("Set SPONSOR_KEY");
const factory = getAddress(process.env.SPONSOR_FACTORY ?? FACTORIES[NETWORK]!);
const pub = publicClient({ network: NETWORK });
const factoryAbi = parseAbi(["function beacon() view returns (address)", "function implementation() view returns (address)", "function treasury() view returns (address)", "function admin() view returns (address)"]);
const beaconAbi = parseAbi(["function owner() view returns (address)", "function upgradeTo(address newImplementation)"]);
const read = (fn: "beacon" | "implementation" | "treasury" | "admin") => pub.readContract({ address: factory, abi: factoryAbi, functionName: fn }) as Promise<Address>;
const [beacon, current, factoryTreasury, admin] = await Promise.all([read("beacon"), read("implementation"), read("treasury"), read("admin")]);
// The V3 treasury is fixed in the implementation; default to the factory's current treasury.
const treasury = getAddress(process.env.V3_TREASURY ?? factoryTreasury);
const owner = getAddress((await pub.readContract({ address: beacon, abi: beaconAbi, functionName: "owner" })) as Address);

const artifact = JSON.parse(readFileSync(new URL("../../../contracts/out/LockedSignerAccountV3.sol/LockedSignerAccountV3.json", import.meta.url), "utf8"));
const relayer = new SponsorWalletRelayer(key, { network: NETWORK });
const deploy = await relayer.relay({ label: "deploy LockedSignerAccountV3 implementation", data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [factory, treasury] }) });
const implementation = getAddress(deploy.contractAddress!);
const code = await pub.getCode({ address: implementation });
if (!code || code === "0x") throw new Error(`no code at ${implementation}`);

const upgradeCalldata = encodeFunctionData({ abi: beaconAbi, functionName: "upgradeTo", args: [implementation] });
const out = {
  network: NETWORK,
  chainId: chainFor(NETWORK).id,
  factory,
  admin,
  beacon,
  beaconOwner: owner,
  beaconOwnerIsLedger: owner === LEDGER,
  previousImplementation: current,
  implementation,
  treasury,
  deployTx: deploy.transactionHash,
  upgraded: false,
  ledgerTx: { from: owner, to: beacon, value: "0", data: upgradeCalldata, function: `upgradeTo(${implementation})` },
  date: new Date().toISOString().slice(0, 10),
};
writeFileSync(new URL(`../../../deployments/${NETWORK}-account-v3.json`, import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
