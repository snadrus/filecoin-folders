import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from "viem";
import { factoryAdminAbi, filSendPlan, maskedIdAddress, maskedIdOf, recoverAll, resolveRecipient, type RecoveryChain } from "../sponsor/recoverlib.js";

const ANDY_F1 = "f1ncgcm7zu25ouka3tnbvuscjcpl3spqg7rdl63wa";
const ANDY_MASKED = getAddress("0xff00000000000000000000000000000000399a90");
const SPONSOR = getAddress("0xa69A4eF204eA951976bd6bDaCbd932Bbd18B08Db");
const USDFC = getAddress("0x80B98d3aa09ffff255c3ba4A241111Ff1262F045");
const FACTORY = getAddress(`0x${"fa".repeat(20)}`);

describe("recovery addresses", () => {
  it("masked ID form of f03775120 (Andy's f1)", () => {
    expect(maskedIdAddress(3775120n).toLowerCase()).toBe("0xff00000000000000000000000000000000399a90");
    expect(ANDY_MASKED.toLowerCase()).toBe("0xff00000000000000000000000000000000399a90");
    expect(maskedIdOf(ANDY_MASKED)).toBe(3775120n);
    expect(maskedIdOf(SPONSOR)).toBeUndefined();
  });
  it("resolves 0x, f0, and f1 (via StateLookupID); rejects wrong network and f4", async () => {
    const lookups: string[] = [];
    const lookup = async (a: string) => (lookups.push(a), "f03775120");
    expect(await resolveRecipient(ANDY_F1, "mainnet", lookup)).toBe(ANDY_MASKED);
    expect(lookups).toEqual([ANDY_F1]);
    expect(await resolveRecipient("f03775120", "mainnet", lookup)).toBe(ANDY_MASKED);
    expect(await resolveRecipient(SPONSOR.toLowerCase(), "mainnet", lookup)).toBe(SPONSOR);
    await expect(resolveRecipient(ANDY_F1, "calibration", lookup)).rejects.toThrow(/t-prefixed/);
    await expect(resolveRecipient("f410fxtprxxa2s7ihdjni54b7d4csew3ofin2x5vynua", "mainnet", lookup)).rejects.toThrow(/0x form/);
  });
  it("FIL plan leaves exactly the worst-case gas fee", () => {
    const plan = filSendPlan({ balance: 10n ** 16n, gasEstimate: 2_000_000n, maxFeePerGas: 300_000n });
    expect(plan.gas).toBe(2_600_000n);
    expect(plan.value + plan.maxFee).toBe(10n ** 16n);
    expect(filSendPlan({ balance: 10n, gasEstimate: 2_000_000n, maxFeePerGas: 300_000n }).value).toBe(0n);
  });
});

function fakeChain(init: { fil: bigint; usdfc: bigint; treasury: Address; admin?: Address }) {
  const balances = new Map<Address, bigint>([[SPONSOR, init.fil]]);
  const tokens = new Map<Address, bigint>([[SPONSOR, init.usdfc]]);
  const pooled = new Map<Address, bigint>([[getAddress(`0x${"aa".repeat(20)}`), 10n ** 18n]]);
  let treasury = init.treasury;
  let admin = init.admin ?? SPONSOR;
  const sent: { label: string; to: Address; value?: bigint }[] = [];
  const add = (m: Map<Address, bigint>, a: Address, v: bigint) => m.set(a, (m.get(a) ?? 0n) + v);
  const GAS_PRICE = 1_000n;
  const chain: RecoveryChain = {
    address: SPONSOR,
    getBalance: async (a) => balances.get(a) ?? 0n,
    usdfcBalance: async (a) => tokens.get(a) ?? 0n,
    estimateGas: async () => 1_000_000n,
    maxFeePerGas: async () => ({ maxFeePerGas: GAS_PRICE, maxPriorityFeePerGas: 10n }),
    read: async (fn) => (fn === "admin" ? admin : treasury),
    async send(tx) {
      sent.push({ label: tx.label, to: tx.to, value: tx.value });
      const gasCost = (tx.gas ?? 500_000n) * GAS_PRICE;
      if ((balances.get(SPONSOR) ?? 0n) < (tx.value ?? 0n) + gasCost) throw new Error("insufficient funds");
      add(balances, SPONSOR, -gasCost - (tx.value ?? 0n));
      if (tx.value) add(balances, tx.to, tx.value);
      if (tx.to === USDFC) {
        const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data! }) as unknown as { args: readonly [Address, bigint] };
        add(tokens, SPONSOR, -args[1]);
        add(tokens, args[0], args[1]);
      }
      if (tx.to === FACTORY) {
        const { functionName, args } = decodeFunctionData({ abi: factoryAdminAbi, data: tx.data! }) as unknown as { functionName: string; args: readonly [Address] };
        if (functionName === "setTreasury") treasury = args[0];
        if (functionName === "setAdmin") admin = args[0];
      }
      return `0x${sent.length.toString(16).padStart(64, "0")}` as Hex;
    },
    async sweep(account) {
      const amount = pooled.get(account) ?? 0n;
      pooled.set(account, 0n);
      add(tokens, treasury, amount);
      add(balances, SPONSOR, -500_000n * GAS_PRICE);
      return { outcome: "swept", swept: String(amount), hash: "0x01" as Hex };
    },
  };
  return { chain, balances, tokens, sent, get treasury() { return treasury; }, get admin() { return admin; } };
}

describe("recoverAll", () => {
  it("dry run sends nothing", async () => {
    const f = fakeChain({ fil: 10n ** 16n, usdfc: 5n * 10n ** 18n, treasury: SPONSOR });
    const report = await recoverAll(f.chain, { filTo: ANDY_MASKED, usdfcTo: ANDY_MASKED, usdfc: USDFC, factory: FACTORY, sweep: [getAddress(`0x${"aa".repeat(20)}`)], dryRun: true });
    expect(f.sent).toEqual([]);
    expect(report.steps.map((s) => s.step)).toEqual(["treasury", `sweep ${getAddress(`0x${"aa".repeat(20)}`)}`, "usdfc", "fil"]);
  });
  it("retargets treasury, sweeps the pool to it, then drains USDFC and FIL (FIL last)", async () => {
    const usdfcTo = getAddress(`0x${"0b".repeat(20)}`);
    const f = fakeChain({ fil: 10n ** 16n, usdfc: 5n * 10n ** 18n, treasury: SPONSOR });
    const report = await recoverAll(f.chain, { filTo: ANDY_MASKED, usdfcTo, usdfc: USDFC, factory: FACTORY, sweep: [getAddress(`0x${"aa".repeat(20)}`)], dryRun: false });
    expect(f.sent.map((s) => s.label)).toEqual(["setTreasury", "transfer USDFC", "send FIL"]);
    expect(f.treasury).toBe(usdfcTo);
    expect(f.tokens.get(usdfcTo)).toBe(6n * 10n ** 18n); // 1 pooled seed swept + 5 held
    expect(report.usdfc.after).toBe(0n);
    expect(f.balances.get(ANDY_MASKED)).toBe(report.fil.sent);
    expect(report.fil.after).toBe(0n); // the fake charges the full max fee; a real chain refunds unused gas (dust)
    expect(f.admin).toBe(SPONSOR); // admin stays unless asked
  });
  it("skips the treasury when this wallet is not the factory admin, and can hand admin over", async () => {
    const other = getAddress(`0x${"0c".repeat(20)}`);
    const f = fakeChain({ fil: 10n ** 16n, usdfc: 0n, treasury: SPONSOR, admin: other });
    const report = await recoverAll(f.chain, { filTo: ANDY_MASKED, usdfcTo: ANDY_MASKED, usdfc: USDFC, factory: FACTORY, dryRun: false });
    expect(report.steps[0]!.detail).toMatch(/skip/);
    expect(f.sent.map((s) => s.label)).toEqual(["send FIL"]);
    const g = fakeChain({ fil: 10n ** 16n, usdfc: 0n, treasury: SPONSOR });
    await recoverAll(g.chain, { filTo: ANDY_MASKED, usdfcTo: other, usdfc: USDFC, factory: FACTORY, newAdmin: other, dryRun: false });
    expect(g.admin).toBe(other);
  });
});
