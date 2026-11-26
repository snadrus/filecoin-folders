// Sponsor backend ("money processor") for gasless FiFolders. Holds the gas wallet, which is also the factory admin and
// treasury. Endpoints (JSON):
//   GET  /account?user=0x…   → { account | null }
//   POST /account {user}     → create the user's LockedSignerAccount (once) and top up storage credits in Filecoin Pay
//   POST /dataset {user, metadata} → one-time dataset: admin allowDataSet + provider createDataSet (keyless signature)
//   POST /execute {account, target, value, data, nonce, deadline, signature} → relay a user-signed Execute
// Credits are a stub: every new account gets SPONSOR_CREDIT_USDFC. A real deployment gates /account and /dataset on
// paid credits and authenticates the caller.
//
//   SPONSOR_KEY=0x… SPONSOR_FACTORY=0x… pnpm --filter fifolders sponsor
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { encodeAbiParameters, encodeFunctionData, encodePacked, erc20Abi, getAddress, isAddress, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { calibration } from "@filoz/synapse-core/chains";
import { createDataSetApiRequest } from "@filoz/synapse-core/sp";
import { getPDPProvider } from "@filoz/synapse-core/sp-registry";
import { lockedAccountAbi, lockedFactoryAbi } from "../src/sponsored-abi.js";
import { SponsorWalletRelayer, publicClient } from "./relayer.js";

const PORT = Number(process.env.SPONSOR_PORT ?? 8787);
const STATE = process.env.SPONSOR_STATE ?? new URL("./sponsor-state.json", import.meta.url).pathname;
const FACTORY = getAddress(required("SPONSOR_FACTORY"));
const PROVIDER_ID = BigInt(process.env.SPONSOR_PROVIDER_ID ?? "2");
const CREDIT = parseUnits(process.env.SPONSOR_CREDIT_USDFC ?? "3", 18);
const ACCOUNT_TTL_SEC = 365n * 86400n;
const PAY = getAddress(calibration.contracts.filecoinPay.address);
const USDFC = getAddress(calibration.contracts.usdfc.address);
const FWSS = getAddress(calibration.contracts.fwss.address);
const PDP = getAddress(calibration.contracts.pdp.address);
const payAbi = parseAbi([
  "function deposit(address token, address to, uint256 amount) payable",
  "function accounts(address token, address owner) view returns (uint256 funds, uint256 lockupCurrent, uint256 lockupRate, uint256 lockupLastSettledAt)",
]);

interface UserRecord {
  account: Address;
  sessionExpiry: string;
  funded?: string;
  dataSetId?: string;
  providerId?: string;
  /** Provider-submitted createDataSet transaction. */
  dataSetTx?: Hex;
}
type State = Record<string, UserRecord>;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

export const state: State = existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as State) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const pub = publicClient();
export const relayer: SponsorWalletRelayer = new SponsorWalletRelayer(required("SPONSOR_KEY") as Hex);
const byAccount = () => new Map(Object.values(state).map((record) => [record.account.toLowerCase(), record]));

function userOf(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new HttpError(400, "user must be an address");
  return getAddress(value);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Create (once) and fund the user's account. Idempotent; tops up only below half the credit. */
async function ensureAccount(user: Address): Promise<{ account: Address; hashes: Hex[] }> {
  const hashes: Hex[] = [];
  let record = state[user.toLowerCase()];
  if (!record) {
    const sessionExpiry = BigInt(Math.floor(Date.now() / 1000)) + ACCOUNT_TTL_SEC;
    const account = (await pub.readContract({ address: FACTORY, abi: lockedFactoryAbi, functionName: "predict", args: [user, 0n, sessionExpiry] })) as Address;
    const receipt = await relayer.relay({ to: FACTORY, label: `create account for ${user}`, data: encodeFunctionData({ abi: lockedFactoryAbi, functionName: "create", args: [user, 0n, sessionExpiry] }) });
    hashes.push(receipt.transactionHash);
    record = state[user.toLowerCase()] = { account: getAddress(account), sessionExpiry: sessionExpiry.toString() };
    save();
  }
  const [funds] = (await pub.readContract({ address: PAY, abi: payAbi, functionName: "accounts", args: [USDFC, record.account] })) as readonly bigint[];
  if ((funds ?? 0n) < CREDIT / 2n) {
    const allowance = await pub.readContract({ address: USDFC, abi: erc20Abi, functionName: "allowance", args: [relayer.address, PAY] });
    if (allowance < CREDIT) hashes.push((await relayer.relay({ to: USDFC, label: "USDFC approve", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PAY, CREDIT * 100n] }) })).transactionHash);
    const receipt = await relayer.relay({ to: PAY, label: `credit ${record.account}`, data: encodeFunctionData({ abi: payAbi, functionName: "deposit", args: [USDFC, record.account, CREDIT] }) });
    hashes.push(receipt.transactionHash);
    record.funded = String(BigInt(record.funded ?? "0") + CREDIT);
    save();
  }
  return { account: record.account, hashes };
}

/** One dataset per user, opened by the sponsor with an FWSS-approved provider. */
async function ensureDataset(user: Address, metadata: Record<string, string>): Promise<{ dataSetId: string; providerId: string; hash?: Hex }> {
  const { account } = await ensureAccount(user);
  const record = state[user.toLowerCase()]!;
  if (record.dataSetId) return { dataSetId: record.dataSetId, providerId: record.providerId ?? "" };
  const keys = Object.keys(metadata).sort();
  const values = keys.map((key) => String(metadata[key]));
  const clientDataSetId = BigInt(Date.now());
  await relayer.relay({ to: account, label: `allowDataSet ${account}`, data: encodeFunctionData({ abi: lockedAccountAbi, functionName: "allowDataSet", args: [PROVIDER_ID, clientDataSetId, keys, values] }) });
  const provider = (await getPDPProvider(pub as never, { providerId: PROVIDER_ID } as never)) as { pdp?: { serviceURL?: string }; products?: { PDP?: { data?: { serviceURL?: string } } } };
  const serviceURL = provider.pdp?.serviceURL ?? provider.products?.PDP?.data?.serviceURL;
  if (!serviceURL) throw new HttpError(502, `provider ${PROVIDER_ID} has no PDP service URL`);
  // Keyless "Nick's method" signature (r = s = 1, v = 27): its signer was authorized for exactly this message.
  const one = `0x${"0".repeat(63)}1` as Hex;
  const signature = encodePacked(["bytes32", "bytes32", "uint8"], [one, one, 27]);
  const extraData = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "string[]" }, { type: "string[]" }, { type: "bytes" }],
    [account, clientDataSetId, keys, values, signature],
  );
  const created = await createDataSetApiRequest({ serviceURL, recordKeeper: FWSS, extraData });
  const receipt = await pub.waitForTransactionReceipt({ hash: created.txHash, timeout: 10 * 60_000, pollingInterval: 5_000 });
  if (receipt.status !== "success") throw new HttpError(502, `createDataSet reverted: ${created.txHash}`);
  const log = receipt.logs.find((entry) => getAddress(entry.address) === PDP && entry.topics[1]);
  if (!log?.topics[1]) throw new HttpError(502, "createDataSet receipt has no DataSetCreated log");
  record.dataSetId = BigInt(log.topics[1]).toString();
  record.providerId = PROVIDER_ID.toString();
  record.dataSetTx = created.txHash;
  save();
  return { dataSetId: record.dataSetId, providerId: record.providerId, hash: created.txHash };
}

/** Relay a user-signed Execute for an account this sponsor created. Policy is enforced on chain; simulate first so
 *  rejected calls cost the sponsor nothing. */
async function relayExecute(body: Record<string, unknown>): Promise<{ hash: Hex }> {
  const account = typeof body.account === "string" && isAddress(body.account) ? getAddress(body.account) : null;
  if (!account || !byAccount().has(account.toLowerCase())) throw new HttpError(404, "unknown sponsored account");
  const target = getAddress(String(body.target));
  const data = String(body.data) as Hex;
  const allowed = await pub.readContract({ address: account, abi: lockedAccountAbi, functionName: "isAllowed", args: [target, data.slice(0, 10) as Hex] });
  if (!allowed) throw new HttpError(403, `call not allowed: ${target} ${data.slice(0, 10)}`);
  const call = encodeFunctionData({
    abi: lockedAccountAbi,
    functionName: "execute",
    args: [target, BigInt(String(body.value ?? 0)), data, BigInt(String(body.nonce)), BigInt(String(body.deadline)), String(body.signature) as Hex],
  });
  try {
    await pub.call({ account: relayer.address, to: account, data: call });
  } catch (error) {
    throw new HttpError(422, `execute would revert: ${(error as { shortMessage?: string }).shortMessage ?? String(error)}`);
  }
  return { hash: await relayer.send({ to: account, data: call, label: `execute ${target} ${data.slice(0, 10)}` }) };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
  res.end(JSON.stringify(body));
}

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://sponsor");
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (req.method === "GET" && url.pathname === "/account") {
      return send(res, 200, { account: state[userOf(url.searchParams.get("user")).toLowerCase()]?.account ?? null });
    }
    if (req.method === "POST" && url.pathname === "/account") return send(res, 200, await ensureAccount(userOf((await readJson(req)).user)));
    if (req.method === "POST" && url.pathname === "/dataset") {
      const body = await readJson(req);
      const metadata = (body.metadata && typeof body.metadata === "object" ? body.metadata : {}) as Record<string, string>;
      return send(res, 200, await ensureDataset(userOf(body.user), metadata));
    }
    if (req.method === "POST" && url.pathname === "/execute") return send(res, 200, await relayExecute(await readJson(req)));
    send(res, 404, { error: "not found" });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    console.error(`[sponsor] ${req.method} ${req.url}:`, error instanceof Error ? error.message : error);
    send(res, status, { error: error instanceof Error ? error.message : String(error) });
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => console.log(`[sponsor] ${relayer.name} ${relayer.address} factory ${FACTORY} on :${PORT}`));
}
