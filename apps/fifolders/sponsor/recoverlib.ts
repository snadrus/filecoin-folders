// Recovery: return everything the sponsor holds to the operator's recovery address(es).
// Shared by the ops CLI (recover.ts) and its tests. See README "Recovery".
//
// Destinations may be Filecoin-native (f1/f3/f0) addresses. The EVM side reaches those through their masked-ID form
// 0xff + 11 zero bytes + the 8-byte actor ID: a FIL value send to it is delivered to the actor (verified on
// Calibration, see test/recover-calibration.test.ts), and an ERC-20 transfer to it credits that address in the token,
// which an f1 holder can later move with `lotus evm invoke`. Prefer a plain 0x address for USDFC when one exists.
import { encodeFunctionData, erc20Abi, getAddress, isAddress, parseAbi, type Address, type Hex } from "viem";

export const factoryAdminAbi = parseAbi([
  "function admin() view returns (address)",
  "function treasury() view returns (address)",
  "function setTreasury(address next)",
  "function setAdmin(address next)",
]);

/** 0xff00…<id>: the EVM form of a Filecoin actor ID. */
export function maskedIdAddress(id: bigint | number | string): Address {
  const n = BigInt(id);
  if (n < 0n || n >= 1n << 64n) throw new Error(`actor id out of range: ${id}`);
  return getAddress(`0xff${"00".repeat(11)}${n.toString(16).padStart(16, "0")}`);
}

/** Actor ID of a masked-ID address, or undefined for an ordinary 0x address. */
export function maskedIdOf(address: Address): bigint | undefined {
  const hex = address.toLowerCase();
  return hex.startsWith(`0xff${"00".repeat(11)}`) ? BigInt(`0x${hex.slice(24)}`) : undefined;
}

export type LookupId = (filecoinAddress: string) => Promise<string>;

/** Lotus `Filecoin.StateLookupID` over JSON-RPC. */
export function lotusLookupId(rpc: string, fetcher: typeof fetch = fetch): LookupId {
  return async (filecoinAddress) => {
    const res = await fetcher(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "Filecoin.StateLookupID", params: [filecoinAddress, null] }) });
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (!body.result) throw new Error(`StateLookupID ${filecoinAddress}: ${body.error?.message ?? "no result"}`);
    return body.result;
  };
}

/**
 * 0x… as is; f0<id>/t0<id> → masked ID; f1/f3 (t1/t3) → actor ID via `lookupId` → masked ID. f410 addresses are
 * EVM accounts: pass their 0x form instead. An f1/f3 that has never received funds has no actor yet: fund it once first.
 */
export async function resolveRecipient(input: string, network: "calibration" | "mainnet", lookupId: LookupId): Promise<Address> {
  const value = input.trim();
  if (isAddress(value, { strict: false })) return getAddress(value);
  const prefix = network === "mainnet" ? "f" : "t";
  if (value[0] !== prefix) throw new Error(`${value}: expected a ${prefix}-prefixed address on ${network}`);
  const protocol = value[1];
  if (protocol === "0" && /^\d+$/.test(value.slice(2))) return maskedIdAddress(value.slice(2));
  if (protocol === "1" || protocol === "3") {
    const id = await lookupId(value);
    if (!/^[ft]0\d+$/.test(id)) throw new Error(`${value}: unexpected actor id ${id}`);
    return maskedIdAddress(id.slice(2));
  }
  throw new Error(`${value}: use the 0x form for f4/f410 (EVM) addresses`);
}

/** FIL to send so that value + worst-case gas fee leaves nothing (bar the refund of unused gas). */
export function filSendPlan(input: { balance: bigint; gasEstimate: bigint; maxFeePerGas: bigint }): { gas: bigint; maxFee: bigint; value: bigint } {
  const gas = (input.gasEstimate * 13n) / 10n; // FEVM estimates run tight
  const maxFee = gas * input.maxFeePerGas;
  return { gas, maxFee, value: input.balance > maxFee ? input.balance - maxFee : 0n };
}

export interface RecoveryChain {
  address: Address;
  getBalance(address: Address): Promise<bigint>;
  usdfcBalance(address: Address): Promise<bigint>;
  estimateGas(tx: { to: Address; value?: bigint; data?: Hex }): Promise<bigint>;
  maxFeePerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  read(fn: "admin" | "treasury", factory: Address): Promise<Address>;
  /** Send and wait for success; returns the tx hash. */
  send(tx: { to: Address; value?: bigint; data?: Hex; gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; label: string }): Promise<Hex>;
  /** Admin sweep of one pooled/terminated account to the factory treasury. */
  sweep?(account: Address): Promise<{ outcome: string; swept?: string; hash?: Hex }>;
}

export interface RecoveryOptions {
  filTo: Address;
  usdfcTo: Address;
  usdfc: Address;
  /** Factory whose treasury should point at usdfcTo (admin must be this wallet). */
  factory?: Address;
  /** Accounts to admin-sweep before draining (their USDFC goes to the treasury). */
  sweep?: Address[];
  /** Also hand factory admin to this address (last step; the sponsor can no longer operate the factory). */
  newAdmin?: Address;
  /** Plan only. */
  dryRun: boolean;
  log?: (line: string) => void;
}

export interface RecoveryReport {
  steps: { step: string; detail: string; hash?: Hex }[];
  fil: { before: bigint; sent: bigint; after?: bigint };
  usdfc: { before: bigint; sent: bigint; after?: bigint };
}

/** Order: point treasury at the recovery address → sweep accounts → USDFC → FIL (last, so gas is still there). */
export async function recoverAll(chain: RecoveryChain, opts: RecoveryOptions): Promise<RecoveryReport> {
  const log = opts.log ?? (() => undefined);
  const steps: RecoveryReport["steps"] = [];
  const step = (s: string, detail: string, hash?: Hex) => {
    steps.push({ step: s, detail, ...(hash ? { hash } : {}) });
    log(`${s}: ${detail}${hash ? ` (${hash})` : ""}`);
  };
  const usdfcBefore = await chain.usdfcBalance(chain.address);
  const filBefore = await chain.getBalance(chain.address);

  if (opts.factory) {
    const [admin, treasury] = await Promise.all([chain.read("admin", opts.factory), chain.read("treasury", opts.factory)]);
    if (getAddress(admin) !== getAddress(chain.address)) step("treasury", `skip: factory admin is ${admin}, not this wallet`);
    else if (getAddress(treasury) === getAddress(opts.usdfcTo)) step("treasury", `already ${treasury}`);
    else if (opts.dryRun) step("treasury", `would set ${treasury} → ${opts.usdfcTo}`);
    else step("treasury", `${treasury} → ${opts.usdfcTo}`, await chain.send({ to: opts.factory, data: encodeFunctionData({ abi: factoryAdminAbi, functionName: "setTreasury", args: [opts.usdfcTo] }), label: "setTreasury" }));
  }

  for (const account of opts.sweep ?? []) {
    if (opts.dryRun || !chain.sweep) step(`sweep ${account}`, opts.dryRun ? "would sweep to treasury" : "skip: no sweeper");
    else {
      const r = await chain.sweep(account);
      step(`sweep ${account}`, r.swept ? `${r.swept} USDFC → treasury` : r.outcome, r.hash);
    }
  }

  const usdfc = await chain.usdfcBalance(chain.address);
  let usdfcSent = 0n;
  if (usdfc === 0n) step("usdfc", "nothing to send");
  else if (opts.dryRun) step("usdfc", `would send ${usdfc} → ${opts.usdfcTo}`);
  else {
    step("usdfc", `${usdfc} → ${opts.usdfcTo}`, await chain.send({ to: opts.usdfc, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [opts.usdfcTo, usdfc] }), label: "transfer USDFC" }));
    usdfcSent = usdfc;
  }

  if (opts.factory && opts.newAdmin) {
    if (opts.dryRun) step("admin", `would hand factory admin → ${opts.newAdmin}`);
    else step("admin", `→ ${opts.newAdmin}`, await chain.send({ to: opts.factory, data: encodeFunctionData({ abi: factoryAdminAbi, functionName: "setAdmin", args: [opts.newAdmin] }), label: "setAdmin" }));
  }

  const balance = await chain.getBalance(chain.address);
  const fees = await chain.maxFeePerGas();
  const plan = filSendPlan({ balance, gasEstimate: await chain.estimateGas({ to: opts.filTo, value: 1n }), maxFeePerGas: fees.maxFeePerGas });
  let filSent = 0n;
  if (plan.value === 0n) step("fil", `balance ${balance} does not cover gas ${plan.maxFee}`);
  else if (opts.dryRun) step("fil", `would send ${plan.value} → ${opts.filTo} (gas ≤ ${plan.maxFee})`);
  else {
    step("fil", `${plan.value} → ${opts.filTo}`, await chain.send({ to: opts.filTo, value: plan.value, gas: plan.gas, ...fees, label: "send FIL" }));
    filSent = plan.value;
  }
  const report: RecoveryReport = { steps, fil: { before: filBefore, sent: filSent }, usdfc: { before: usdfcBefore, sent: usdfcSent } };
  if (!opts.dryRun) {
    report.fil.after = await chain.getBalance(chain.address);
    report.usdfc.after = await chain.usdfcBalance(chain.address);
  }
  return report;
}
