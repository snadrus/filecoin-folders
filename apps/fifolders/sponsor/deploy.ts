// One-time: deploy LockedSignerAccountFactory (admin = sponsor; treasury = SPONSOR_TREASURY, else the sponsor).
// Treasury receives every admin sweep (unassigned pool accounts, terminated/unspent funds). Point it at the operator's
// recovery address (0x, or the masked-ID form of an f1/f0) so those funds return there; admin can change it later
// with setTreasury (see recover.ts --factory). The account call policy is compiled in;
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
const treasury = getAddress(process.env.SPONSOR_TREASURY ?? relayer.address);
const deployed = await relayer.relay({
  label: "deploy LockedSignerAccountFactory",
  data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [fwss, registry, relayer.address, treasury] }),
});
console.log(JSON.stringify({ contract: "LockedSignerAccountFactory", address: getAddress(deployed.contractAddress!), admin: relayer.address, treasury, registry, fwss, txHash: deployed.transactionHash, block: Number(deployed.blockNumber), gasUsed: Number(deployed.gasUsed) }));
