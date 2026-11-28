// One-time: deploy FolderRegistryV2 (owner = the deploying sponsor wallet; it may only replace the session-key
// registry, it is not a volume owner). Session-key registry = the network's FWSS SessionKeyRegistry.
//   forge build --root contracts
//   SPONSOR_NETWORK=mainnet SPONSOR_KEY=0x… tsx apps/trefolders/sponsor/deploy-registry.ts
import { readFileSync } from "node:fs";
import { encodeDeployData, getAddress, type Address, type Hex } from "viem";
import { CHAIN, SponsorWalletRelayer } from "./relayer.js";

const artifact = JSON.parse(readFileSync(new URL("../../../contracts/out/FolderRegistryV2.sol/FolderRegistryV2.json", import.meta.url), "utf8"));
const relayer = new SponsorWalletRelayer(process.env.SPONSOR_KEY as Hex);
const skr = getAddress((CHAIN.contracts as unknown as { sessionKeyRegistry: { address: Address } }).sessionKeyRegistry.address);
const owner = getAddress(process.env.REGISTRY_OWNER ?? relayer.address);
const deployed = await relayer.relay({ label: "deploy FolderRegistryV2", data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner, skr] }) });
console.log(JSON.stringify({ contract: "FolderRegistryV2", address: getAddress(deployed.contractAddress!), owner, sessionKeyRegistry: skr, txHash: deployed.transactionHash, block: Number(deployed.blockNumber), gasUsed: Number(deployed.gasUsed) }));
