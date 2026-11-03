/** /fideploy/ pure logic: known deployments, bytecode status, deploy data, deployments JSON. */
import { encodeAbiParameters, formatEther, getAddress, type Address, type Hex } from "viem";
import artifacts from "./artifacts.json";

export type ContractName = "FolderRegistryV2" | "FiClub" | "SessionKeyRegistry";
export interface Artifact { name: string; abi: { inputs?: { name: string; type: string }[] }[]; bytecode: Hex; deployedBytecode: Hex; compiler: string }
export const ARTIFACTS = artifacts as unknown as Record<"FolderRegistryV2" | "FiClub", Artifact>;

export interface ChainInfo { id: number; name: string; testnet: boolean; rpc: string; explorer?: string; faucet?: string; known: Partial<Record<ContractName, Address>> }

/** Canonical SessionKeyRegistry from @filoz/synapse-core; suite contracts from deployments/*.json. */
export const CHAINS: Record<number, ChainInfo> = {
  314: { id: 314, name: "Filecoin Mainnet", testnet: false, rpc: "https://api.node.glif.io/rpc/v1", explorer: "https://filfox.info/en/address/", known: { SessionKeyRegistry: "0x74FD50525A958aF5d484601E252271f9625231aB" } },
  314159: {
    id: 314159,
    name: "Filecoin Calibration",
    testnet: true,
    rpc: "https://api.calibration.node.glif.io/rpc/v1",
    explorer: "https://calibration.filfox.info/en/address/",
    faucet: "https://faucet.calibnet.chainsafe-fil.io/",
    known: { FolderRegistryV2: "0x9C06335D7DE588Caa104ee4FC3bb7cd8Aba62443", FiClub: "0x412B9363019591588073B3489CB09d28d2a55A03", SessionKeyRegistry: "0x518411c2062E119Aaf7A8B12A2eDf9a939347655" },
  },
};

export function chainInfo(id: number, customRpc = ""): ChainInfo {
  return CHAINS[id] ?? { id, name: `Custom chain ${id}`, testnet: true, rpc: customRpc, known: {} };
}

export type CodeStatus = "match" | "absent" | "different";
/** Exact runtime-bytecode comparison (the suite contracts have no immutables; metadata hash included). */
export function codeStatus(onchain: Hex | undefined | null, expected?: Hex): CodeStatus {
  if (!onchain || onchain === "0x") return "absent";
  if (!expected) return "match"; // SessionKeyRegistry: presence is enough, we do not ship its bytecode.
  return onchain.toLowerCase() === expected.toLowerCase() ? "match" : "different";
}

/** Creation data for a deploy transaction. FolderRegistryV2 takes (owner, sessionKeyRegistry). */
export function deployData(name: "FolderRegistryV2" | "FiClub", owner: Address, sessionKeyRegistry?: Address): Hex {
  const a = ARTIFACTS[name];
  if (name === "FiClub") return a.bytecode;
  if (!sessionKeyRegistry) throw new Error("FolderRegistryV2 needs a SessionKeyRegistry on this chain.");
  return (a.bytecode + encodeAbiParameters([{ type: "address" }, { type: "address" }], [getAddress(owner), getAddress(sessionKeyRegistry)]).slice(2)) as Hex;
}

/** "~0.0123 FIL" from gas × price (wei), rounded up at 4 decimals. */
export function formatCost(gas: bigint, gasPrice: bigint): string {
  const wei = gas * gasPrice;
  const fil = Number(formatEther(wei));
  return `~${(Math.ceil(fil * 10_000) / 10_000).toFixed(4)} FIL`;
}

export interface DeploymentRecord { contract: ContractName; address: Address; txHash?: Hex; block?: number; deployer?: Address; sessionKeyRegistry?: Address; verified: CodeStatus; date: string }

export function deploymentsJson(chain: ChainInfo, records: DeploymentRecord[], commit = ""): string {
  return JSON.stringify(
    { network: chain.id === 314 ? "filecoin-mainnet" : chain.id === 314159 ? "filecoin-calibration" : `custom-${chain.id}`, chainId: chain.id, compiler: `solc ${ARTIFACTS.FiClub.compiler}`, ...(commit ? { commit } : {}), deployments: records },
    null,
    2,
  );
}

/** Private test instances this browser deployed, per chain. */
export function loadPrivate(chainId: number, store: Pick<Storage, "getItem"> = localStorage): DeploymentRecord[] {
  try {
    return JSON.parse(store.getItem(`fideploy:${chainId}`) || "[]") as DeploymentRecord[];
  } catch {
    return [];
  }
}
export function savePrivate(chainId: number, rec: DeploymentRecord, store: Pick<Storage, "getItem" | "setItem"> = localStorage): DeploymentRecord[] {
  const list = [...loadPrivate(chainId, store).filter((r) => r.address.toLowerCase() !== rec.address.toLowerCase()), rec];
  store.setItem(`fideploy:${chainId}`, JSON.stringify(list));
  return list;
}
