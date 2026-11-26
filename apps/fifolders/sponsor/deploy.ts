// One-time: deploy LockedSignerAccountFactory (admin = treasury = sponsor) and allowlist FolderRegistry v2 `commit`.
//   pnpm --dir ../../contracts exec forge build   (or: forge build --root contracts)
//   SPONSOR_KEY=0x… tsx apps/fifolders/sponsor/deploy.ts
import { readFileSync } from "node:fs";
import { encodeDeployData, encodeFunctionData, getAddress, toFunctionSelector, type Hex } from "viem";
import { calibration } from "@filoz/synapse-core/chains";
import { CALIBRATION_REGISTRY_V2 } from "fil-folders";
import { lockedFactoryAbi } from "../src/sponsored-abi.js";
import { SponsorWalletRelayer } from "./relayer.js";

const artifact = JSON.parse(readFileSync(new URL("../../../contracts/out/LockedSignerAccount.sol/LockedSignerAccountFactory.json", import.meta.url), "utf8"));
const relayer = new SponsorWalletRelayer(process.env.SPONSOR_KEY as Hex);
const fwss = getAddress(calibration.contracts.fwss.address);
const deployed = await relayer.relay({
  label: "deploy LockedSignerAccountFactory",
  data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [fwss, relayer.address, relayer.address] }),
});
const factory = getAddress(deployed.contractAddress!);
console.log(`factory ${factory} (tx ${deployed.transactionHash})`);
const commit = toFunctionSelector("commit(bytes32,bytes32,bytes,uint64)");
const allowed = await relayer.relay({
  to: factory,
  label: "allow FolderRegistryV2.commit",
  data: encodeFunctionData({ abi: lockedFactoryAbi, functionName: "setAppAllowed", args: [CALIBRATION_REGISTRY_V2, commit, true] }),
});
console.log(`allowlisted ${CALIBRATION_REGISTRY_V2}.${commit} (tx ${allowed.transactionHash})`);
