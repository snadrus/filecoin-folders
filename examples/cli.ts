#!/usr/bin/env tsx
/**
 * ls / put / get a fil-folders volume on Filecoin Calibration.
 *
 *   PRIVATE_KEY=0x... REGISTRY=0x... pnpm example ls <volume> [path]
 *   PRIVATE_KEY=0x... REGISTRY=0x... pnpm example put <volume> <path> <localFile> [--mime <type>]
 *   PRIVATE_KEY=0x... REGISTRY=0x... pnpm example get <volume> <path> [outFile]
 *
 * PRIVATE_KEY is read from the environment and never printed.
 * RPC_URL defaults to https://api.calibration.node.glif.io/rpc/v1 (chain id 314159).
 */
import { readFile, writeFile } from "node:fs/promises";
import { calibration } from "@filoz/synapse-core/chains";
import { Synapse } from "@filoz/synapse-sdk";
import { createPublicClient, createWalletClient, http, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createViemRegistry, openVolume } from "fil-folders";

const DEFAULT_RPC = "https://api.calibration.node.glif.io/rpc/v1";

async function main(): Promise<void> {
  const { args, mime } = parseArgs(process.argv.slice(2));
  const command = args[0];
  if (!command || command === "help" || command === "--help" || args.includes("--help")) {
    usage();
    return;
  }
  const privateKey = readPrivateKey();
  const registryAddress = process.env.REGISTRY?.trim();
  if (!registryAddress || !isAddress(registryAddress)) {
    throw new Error("REGISTRY must be the FolderRegistry address");
  }
  const rpcUrl = process.env.RPC_URL?.trim() || DEFAULT_RPC;
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: calibration, transport });
  const walletClient = createWalletClient({ account, chain: calibration, transport });
  const synapse = Synapse.create({
    account,
    chain: calibration,
    transport,
    source: "fil-folders",
  });
  const volumeName = args[1];
  if (!volumeName) throw new Error("volume name is required");
  const volume = await openVolume({
    synapse,
    registry: createViemRegistry({ address: registryAddress, publicClient, walletClient }),
    owner: account.address,
    name: volumeName,
  });
  console.error(`account ${account.address}`);

  if (command === "ls") {
    const entries = await volume.ls(args[2] ?? "/");
    for (const entry of entries) {
      console.log(`${entry.type}\t${entry.size}\t${entry.name}`);
    }
    return;
  }
  if (command === "put") {
    const remote = args[2];
    const local = args[3];
    if (!remote || !local) throw new Error("put requires <path> <localFile>");
    const bytes = new Uint8Array(await readFile(local));
    const stat = await volume.put(remote, bytes, mime ? { mime } : undefined);
    console.error(`put ${stat.path} (${stat.size} bytes)`);
    return;
  }
  if (command === "get") {
    const remote = args[2];
    if (!remote) throw new Error("get requires <path>");
    const bytes = await volume.get(remote);
    const outFile = args[3];
    if (outFile) {
      await writeFile(outFile, bytes);
      console.error(`wrote ${outFile} (${bytes.byteLength} bytes)`);
    } else {
      process.stdout.write(bytes);
    }
    return;
  }
  throw new Error(`unknown command ${command}`);
}

function parseArgs(argv: string[]): { args: string[]; mime?: string } {
  const args = [...argv];
  const mimeAt = args.indexOf("--mime");
  if (mimeAt === -1) return { args };
  const mime = args[mimeAt + 1];
  if (!mime || mime.startsWith("--")) throw new Error("--mime requires a value");
  args.splice(mimeAt, 2);
  return { args, mime };
}

function readPrivateKey(): Hex {
  const raw = process.env.PRIVATE_KEY?.trim();
  if (!raw) throw new Error("PRIVATE_KEY is not set");
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("PRIVATE_KEY must be a 32-byte hex string");
  return hex as Hex;
}

function usage(): void {
  console.error(`Usage:
  pnpm example ls <volume> [path]
  pnpm example put <volume> <path> <localFile> [--mime <type>]
  pnpm example get <volume> <path> [outFile]

Environment:
  PRIVATE_KEY   32-byte hex (never printed)
  REGISTRY      FolderRegistry address
  RPC_URL       default ${DEFAULT_RPC}`);
}

function redact(text: string): string {
  let out = text.replace(/0x[a-fA-F0-9]{64}/g, "0x[redacted]");
  const key = process.env.PRIVATE_KEY;
  if (key && key.length >= 32) out = out.split(key).join("[redacted]");
  return out;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(redact(message));
  process.exitCode = 1;
});
