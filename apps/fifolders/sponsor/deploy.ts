// One-time: deploy LockedSignerAccountFactory (admin = treasury = sponsor). The account call policy is compiled in;
// the only app target is the immutable FolderRegistryV2 passed here (zero disables registry commits).
//   forge build --root contracts
//   SPONSOR_KEY=0x… tsx apps/fifolders/sponsor/deploy.ts
import { readFileSync } from "node:fs";
import { encodeDeployData, getAddress, type Address, type Hex } from "viem";
import { CALIBRATION_REGISTRY_V2 } from "fil-folders";
import { CHAIN, NETWORK, SponsorWalletRelayer } from "./relayer.js";

const artifact = JSON.parse(readFileSync(new URL("../../../contracts/out/LockedSignerAccount.sol/LockedSignerAccountFactory.json", import.meta.url), "utf8"));
const relayer = new SponsorWalletRelayer(process.env.SPONSOR_KEY as Hex);
const fwss = getAddress((CHAIN.contracts as unknown as { fwss: { address: Address } }).fwss.address);
const registry = getAddress(process.env.SPONSOR_REGISTRY ?? (NETWORK === "calibration" ? CALIBRATION_REGISTRY_V2 : `0x${"0".repeat(40)}`));
const deployed = await relayer.relay({
  label: "deploy LockedSignerAccountFactory",
  data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [fwss, registry, relayer.address, relayer.address] }),
});
console.log(`factory ${getAddress(deployed.contractAddress!)} registry ${registry} (tx ${deployed.transactionHash})`);
