import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CasConflictError,
  MemoryStorage,
  PIECE_CID_MAX_BYTES,
  RegistryCasConflict,
  RegistryNotAuthorized,
  bytesToPieceCid,
  createViemRegistry,
  folderRegistryAbi,
  namespaceId,
  openVolume,
  pieceCidToBytes,
  volumeKey,
} from "../src/index.js";

const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const WRITER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const contractsDir = fileURLToPath(new URL("../../../contracts", import.meta.url));

const owner = privateKeyToAccount(OWNER_KEY);
const writer = privateKeyToAccount(WRITER_KEY);

let anvil: ChildProcess | undefined;
let rpc = "";
let address: Address;
let publicClient: PublicClient;
let ownerWallet: WalletClient;
let writerWallet: WalletClient;

const foundryEnv = (): NodeJS.ProcessEnv => {
  const bin = resolve(process.env.HOME ?? "", ".foundry/bin");
  const path = process.env.PATH ?? "";
  if (existsSync(bin) && !path.split(delimiter).includes(bin)) {
    return { ...process.env, PATH: `${bin}${delimiter}${path}` };
  }
  return process.env;
};

describe("viem registry on anvil", () => {
  beforeAll(async () => {
    execFileSync("forge", ["build", "--root", contractsDir], { env: foundryEnv(), stdio: "pipe" });
    const launched = await startAnvil();
    anvil = launched.proc;
    rpc = launched.url;
    const chain = defineChain({
      id: 31337,
      name: "anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    });
    const transport = http(rpc);
    publicClient = createPublicClient({ chain, transport });
    ownerWallet = createWalletClient({ account: owner, chain, transport });
    writerWallet = createWalletClient({ account: writer, chain, transport });
    address = await deploy(chain.id);
  }, 120_000);

  afterAll(() => {
    anvil?.kill("SIGTERM");
  });

  it("matches the compiled ABI and the piece-CID limit", async () => {
    const artifact = JSON.parse(readFileSync(resolve(contractsDir, "out/FolderRegistry.sol/FolderRegistry.json"), "utf8")) as {
      abi: { type: string; name?: string; inputs?: { type: string }[] }[];
    };
    expect(signatures(artifact.abi)).toEqual(signatures([...folderRegistryAbi]));
    const limit = await publicClient.readContract({
      address,
      abi: folderRegistryAbi,
      functionName: "MAX_PIECE_CID_BYTES",
    });
    expect(limit).toBe(BigInt(PIECE_CID_MAX_BYTES));
  });

  it("commits as the owner, commits for a writer, and revokes the writer", async () => {
    const registry = createViemRegistry({ address, publicClient, walletClient: ownerWallet });
    const ns = namespaceId();
    const key = volumeKey("owner-volume");
    const first = await registry.commit({
      owner: owner.address,
      ns,
      key,
      pieceCid: pieceCidToBytes("mem:owner"),
      prevPieceCid: new Uint8Array(),
    });
    expect(first.version).toBe(1n);
    const ownerTx = await publicClient.getTransaction({ hash: first.txHash! });
    expect(ownerTx.input.startsWith(toFunctionSelector("commit(bytes32,bytes32,bytes,bytes)"))).toBe(true);

    await registry.setWriter(ns, writer.address, true);
    expect(await registry.isWriter(owner.address, ns, writer.address)).toBe(true);

    const asWriter = createViemRegistry({ address, publicClient, walletClient: writerWallet });
    const second = await asWriter.commit({
      owner: owner.address,
      ns,
      key: volumeKey("writer-volume"),
      pieceCid: pieceCidToBytes("mem:writer"),
      prevPieceCid: new Uint8Array(),
    });
    const writerTx = await publicClient.getTransaction({ hash: second.txHash! });
    expect(writerTx.input.startsWith(toFunctionSelector("commitFor(address,bytes32,bytes32,bytes,bytes)"))).toBe(true);

    const logs = await registry.committed({ owner: owner.address, ns, key });
    expect(logs.map((entry) => bytesToPieceCid(entry.pieceCid))).toEqual(["mem:owner"]);
    expect(logs[0]?.timestamp).toBeGreaterThan(0n);

    await expect(
      registry.commit({
        owner: owner.address,
        ns,
        key,
        pieceCid: pieceCidToBytes("mem:stale"),
        prevPieceCid: new Uint8Array(),
      }),
    ).rejects.toMatchObject({
      name: "RegistryCasConflict",
      currentVersion: 1n,
    } satisfies Partial<RegistryCasConflict>);

    await registry.setWriter(ns, writer.address, false);
    await expect(
      asWriter.commit({
        owner: owner.address,
        ns,
        key: volumeKey("writer-volume"),
        pieceCid: pieceCidToBytes("mem:nope"),
        prevPieceCid: pieceCidToBytes("mem:writer"),
      }),
    ).rejects.toBeInstanceOf(RegistryNotAuthorized);
  });

  it("drives a volume and merges a conflicting commit", async () => {
    const storage = new MemoryStorage();
    const registry = createViemRegistry({ address, publicClient, walletClient: ownerWallet });
    const left = await openVolume({ storage, registry, owner: owner.address, name: "anvil", now: () => 1_700_000_000_000 });
    const right = await openVolume({ storage, registry, owner: owner.address, name: "anvil", now: () => 1_700_000_000_000 });
    await right.tx(async (draft) => {
      await left.put("/a.txt", text("A"));
      await draft.put("/b.txt", text("B"));
    });
    expect(decode(await right.get("/a.txt"))).toBe("A");
    expect(decode(await left.get("/b.txt"))).toBe("B");
    const head = await registry.head(owner.address, namespaceId(), volumeKey("anvil"));
    expect(head.version).toBe(2n);
    expect(bytesToPieceCid(head.pieceCid)).toBe((await left.history()).at(-1)?.pieceCid);

    const third = await openVolume({ storage, registry, owner: owner.address, name: "anvil", now: () => 1_700_000_000_000 });
    const fourth = await openVolume({ storage, registry, owner: owner.address, name: "anvil", now: () => 1_700_000_000_000 });
    await expect(
      fourth.tx(async (draft) => {
        await third.put("/a.txt", text("third"));
        await draft.put("/a.txt", text("fourth"));
      }),
    ).rejects.toBeInstanceOf(CasConflictError);
  });
});

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function signatures(abi: readonly { type: string; name?: string; inputs?: readonly { type: string }[] }[]): string[] {
  return abi
    .filter((item) => item.type !== "constructor")
    .map((item) => `${item.type} ${item.name ?? ""}(${(item.inputs ?? []).map((input) => input.type).join(",")})`)
    .sort();
}

async function deploy(chainId: number): Promise<Address> {
  const artifact = JSON.parse(readFileSync(resolve(contractsDir, "out/FolderRegistry.sol/FolderRegistry.json"), "utf8")) as {
    bytecode: { object: Hex };
  };
  const hash = await ownerWallet.deployContract({
    abi: folderRegistryAbi,
    bytecode: artifact.bytecode.object,
    account: owner,
    chain: { id: chainId, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } },
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("deploy did not return a contract address");
  return receipt.contractAddress;
}

async function startAnvil(): Promise<{ proc: ChildProcess; url: string }> {
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const url = `http://127.0.0.1:${port}`;
    try {
      const proc = await launch(url, port);
      return { proc, url };
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`could not start anvil: ${last}`);
}

function launch(url: string, port: number): Promise<ChildProcess> {
  return new Promise((resolveReady, reject) => {
    const proc = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], {
      env: foundryEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    let settled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      if (error) {
        proc.kill("SIGTERM");
        reject(error);
      } else resolveReady(proc);
    };
    proc.stdout?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
    });
    proc.on("error", (error) => finish(error));
    proc.on("exit", (code) => {
      if (!settled) finish(new Error(`anvil exited ${code ?? "unknown"}: ${log}`));
    });
    const started = Date.now();
    timer = setInterval(() => {
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      })
        .then((response) => {
          if (!response.ok) return;
          finish();
        })
        .catch(() => {
          if (Date.now() - started > 10_000) {
            clearInterval(timer);
            finish(new Error(`anvil did not answer: ${log}`));
          }
        });
    }, 100);
  });
}
