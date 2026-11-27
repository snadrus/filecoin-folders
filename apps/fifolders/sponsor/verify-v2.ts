// Calibration checks for the v2 beacon factory. Never prints SPONSOR_KEY.
// View-only by default. With SPONSOR_KEY: create a throwaway owner account (no USDFC),
// add a session key, send a session-key FolderRegistryV2.commit, and show that a
// session-key USDFC.transfer reverts.
import { readFileSync } from "node:fs";
import { concat, encodeFunctionData, erc20Abi, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EXECUTE_TYPES, executeDomain, lockedAccountAbi, lockedFactoryAbi } from "@fifolders/sponsored-client";
import { CALIBRATION_REGISTRY_V2 } from "fil-folders";
import { NETWORK, SponsorWalletRelayer, publicClient } from "./relayer.js";

const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const deployment = JSON.parse(readFileSync(new URL("../../../deployments/calibration-factory-v2.json", import.meta.url), "utf8")) as {
  address: Address;
  beacon: Address;
  implementation: Address;
};
const factory = getAddress(process.env.SPONSOR_FACTORY ?? deployment.address);
const pub = publicClient({ network: NETWORK });
const token = getAddress((await pub.readContract({ address: factory, abi: lockedFactoryAbi, functionName: "TOKEN" })) as Address);
const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(`0x${"11".repeat(20)}`), 1n] });
const transferSel = transfer.slice(0, 10) as Hex;

const beacon = getAddress((await pub.readContract({ address: factory, abi: lockedFactoryAbi, functionName: "beacon" })) as Address);
const implementation = getAddress((await pub.readContract({ address: factory, abi: lockedFactoryAbi, functionName: "implementation" })) as Address);
const admin = getAddress((await pub.readContract({ address: factory, abi: lockedFactoryAbi, functionName: "admin" })) as Address);
const beaconOwner = getAddress((await pub.readContract({ address: beacon, abi: [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], functionName: "owner" })) as Address);
const views = {
  network: NETWORK,
  factory,
  beacon,
  implementation,
  admin,
  beaconOwner,
  sessionTransferAllowed: await pub.readContract({
    address: implementation,
    abi: lockedAccountAbi,
    functionName: "isSessionAllowed",
    args: [token, transferSel],
  }).catch(() => "implementation-not-initialized"),
};
console.log(JSON.stringify({ views }, null, 2));
if (views.sessionTransferAllowed === true) {
  throw new Error("v2 implementation allows a session-key USDFC transfer; expected false");
}

const key = process.env.SPONSOR_KEY as Hex | undefined;
if (!key) {
  console.log(JSON.stringify({ execute: "skipped (no SPONSOR_KEY)" }));
  process.exit(0);
}
if (NETWORK !== "calibration") {
  throw new Error("verify-v2 is Calibration-only");
}

const relayer = new SponsorWalletRelayer(key);
const owner = privateKeyToAccount(generatePrivateKey());
const session = privateKeyToAccount(generatePrivateKey());
const salt = BigInt(keccak256(toHex(`verify-v2:${Date.now()}`)));
const expiry = BigInt(Math.floor(Date.now() / 1000) + 86400);
const account = getAddress((await pub.readContract({
  address: factory,
  abi: lockedFactoryAbi,
  functionName: "predict",
  args: [owner.address, ZERO32, ZERO32, salt, expiry],
})) as Address);
const created = await relayer.relay({
  to: factory,
  label: "verify create",
  data: encodeFunctionData({ abi: lockedFactoryAbi, functionName: "create", args: [owner.address, ZERO32, ZERO32, salt, expiry] }),
});

async function signExecute(signer: typeof owner, target: Address, data: Hex) {
  const nonce = (await pub.readContract({ address: account, abi: lockedAccountAbi, functionName: "nonce" })) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const message = { target, value: 0n, data, nonce, deadline };
  const signature = await signer.signTypedData({ domain: executeDomain(314159, account), types: EXECUTE_TYPES, primaryType: "Execute", message });
  return { ...message, signature, call: encodeFunctionData({ abi: lockedAccountAbi, functionName: "execute", args: [target, 0n, data, nonce, deadline, signature] }) };
}

const addKey = await signExecute(owner, account, encodeFunctionData({ abi: lockedAccountAbi, functionName: "addSessionKey", args: [session.address, expiry] }));
const added = await relayer.relay({ to: account, data: addKey.call, label: "verify addSessionKey" });

const registry = getAddress(CALIBRATION_REGISTRY_V2);
const ns = keccak256(toHex("fifolders:verify-v2"));
const volKey = keccak256(concat([account, toHex("smoke")]));
const commitData = encodeFunctionData({
  abi: [{ type: "function", name: "commit", inputs: [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes" }, { type: "uint64" }], outputs: [] }],
  functionName: "commit",
  args: [ns, volKey, toHex("v2-smoke"), 0n],
});
const commit = await signExecute(session, registry, commitData);
const committed = await relayer.relay({ to: account, data: commit.call, label: "verify session commit" });

const blocked = await signExecute(session, token, transfer);
let transferRejected: string;
try {
  await pub.call({ account: relayer.address, to: account, data: blocked.call });
  transferRejected = "call succeeded (unexpected)";
} catch (error) {
  transferRejected = (error as { shortMessage?: string }).shortMessage ?? (error instanceof Error ? error.message : String(error));
}
if (!/not allowed|CallNotAllowed|reverted/i.test(transferRejected) || transferRejected === "call succeeded (unexpected)") {
  throw new Error(`session-key USDFC transfer was not rejected: ${transferRejected}`);
}

console.log(JSON.stringify({
  execute: {
    account,
    owner: owner.address,
    session: session.address,
    create: created.transactionHash,
    addSessionKey: added.transactionHash,
    sessionCommit: committed.transactionHash,
    sessionTransferRejected: transferRejected,
  },
}, null, 2));
