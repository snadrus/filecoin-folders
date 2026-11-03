// Injected EIP-1193 test wallet. The key stays in the Node process; it is never sent to the page or logged.
import { readFileSync, existsSync } from "node:fs";
import type { Page } from "@playwright/test";
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { filecoinCalibration } from "viem/chains";

const ENV = process.env.CALIB_WALLET_ENV || "/workspace/scionhub/secrets/calib-wallet.env";
export const RPC = process.env.CALIB_RPC || "https://api.calibration.node.glif.io/rpc/v1";
export const CHAIN_ID = "0x4cb2f"; // 314159

function loadKey(): Hex | null {
  if (process.env.CALIB_PRIVATE_KEY) return process.env.CALIB_PRIVATE_KEY as Hex;
  if (!existsSync(ENV)) return null;
  const line = readFileSync(ENV, "utf8").split("\n").find((l) => l.startsWith("CALIB_PRIVATE_KEY="));
  if (!line) return null;
  const v = line.slice("CALIB_PRIVATE_KEY=".length).trim().replace(/^["']|["']$/g, "");
  return (v.startsWith("0x") ? v : `0x${v}`) as Hex;
}

export const hasWallet = () => loadKey() !== null;

export type Mode = { kind: "approve" } | { kind: "reject" } | { kind: "delay"; ms: number } | { kind: "hang" };

export interface TestWallet {
  address: string;
  calls: { method: string; at: number; outcome: string }[];
  /** Per-method behavior; key "*" is the default for signing methods. */
  modes: Record<string, Mode>;
  locked: boolean;
  /** Chain the wallet reports; emit("chainChanged") and wallet_switchEthereumChain update it. */
  chainId: string;
  allowTx: (tx: { to?: string; data?: string; value?: string }) => boolean;
  emit(event: "accountsChanged" | "chainChanged", value: unknown): Promise<void>;
}

const SIGNING = new Set(["personal_sign", "eth_sign", "eth_signTypedData_v4", "eth_sendTransaction", "eth_requestAccounts"]);

export async function installWallet(page: Page, opts: { allowTx?: TestWallet["allowTx"] } = {}): Promise<TestWallet> {
  const key = loadKey();
  if (!key) throw new Error("no test wallet key");
  const account = privateKeyToAccount(key);
  const rpc = createPublicClient({ chain: filecoinCalibration, transport: http(RPC) });
  const w: TestWallet = {
    address: account.address,
    calls: [],
    modes: {},
    locked: false,
    chainId: CHAIN_ID,
    // Default: no transactions at all (spend needs Andy's approval).
    allowTx: opts.allowTx ?? (() => false),
    emit: async (event, value) => {
      if (event === "chainChanged") w.chainId = String(value);
      await page.evaluate(([e, v]) => (window as any).__testWallet.emit(e, v), [event, value] as const);
    },
  };
  await page.exposeFunction("__walletRequest", async (method: string, params: unknown[]) => {
    const rec = { method, at: Date.now(), outcome: "ok" };
    w.calls.push(rec);
    const fail = (code: number, message: string) => {
      rec.outcome = `err ${code}`;
      return { error: { code, message } };
    };
    if (SIGNING.has(method)) {
      const mode = w.modes[method] ?? w.modes["*"] ?? { kind: "approve" };
      if (mode.kind === "reject") return fail(4001, "User rejected the request.");
      if (mode.kind === "hang") await new Promise(() => {});
      if (mode.kind === "delay") await new Promise((r) => setTimeout(r, mode.ms));
    }
    try {
      switch (method) {
        case "eth_requestAccounts":
          if (w.locked) return fail(4100, "Wallet is locked.");
          return { result: [account.address] };
        case "eth_accounts":
          return { result: w.locked ? [] : [account.address] };
        case "eth_chainId":
          return { result: w.chainId };
        case "net_version":
          return { result: "314159" };
        case "wallet_switchEthereumChain":
          w.chainId = String((params as { chainId?: string }[])[0]?.chainId ?? CHAIN_ID);
          return { result: null };
        case "wallet_addEthereumChain":
          return { result: null };
        case "wallet_requestPermissions":
          return { result: [{ parentCapability: "eth_accounts" }] };
        case "personal_sign": {
          const [msg] = params as [Hex];
          return { result: await account.signMessage({ message: { raw: msg } }) };
        }
        case "eth_signTypedData_v4": {
          const data = JSON.parse(String((params as unknown[])[1]));
          const { EIP712Domain: _d, ...types } = data.types;
          return { result: await account.signTypedData({ domain: data.domain, types, primaryType: data.primaryType, message: data.message }) };
        }
        case "eth_sendTransaction": {
          const tx = (params as any[])[0] ?? {};
          if (!w.allowTx(tx)) return fail(4001, "Blocked by test harness: spending needs Andy approval.");
          const req = await rpc.prepareTransactionRequest({ account, to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, chain: filecoinCalibration });
          const signed = await account.signTransaction(req as any);
          return { result: await rpc.sendRawTransaction({ serializedTransaction: signed }) };
        }
        default: {
          if (w.chainId !== CHAIN_ID && method.startsWith("eth_")) return fail(-32603, "test wallet is on another chain");
          const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
          const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
          if (body.error) return fail(body.error.code, body.error.message);
          return { result: body.result };
        }
      }
    } catch (e) {
      return fail(-32603, e instanceof Error ? e.message.slice(0, 200) : "error");
    }
  });
  await page.addInitScript(() => {
    const listeners: Record<string, ((v: unknown) => void)[]> = {};
    const provider = {
      isMetaMask: true,
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        const r = await (window as any).__walletRequest(method, params ?? []);
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return r.result;
      },
      on: (e: string, f: (v: unknown) => void) => ((listeners[e] ??= []).push(f), provider),
      removeListener: (e: string, f: (v: unknown) => void) => ((listeners[e] = (listeners[e] ?? []).filter((x) => x !== f)), provider),
    };
    (window as any).__testWallet = { emit: (e: string, v: unknown) => (listeners[e] ?? []).forEach((f) => f(v)) };
    (window as any).ethereum = provider;
    const info = { uuid: "00000000-0000-4000-8000-000000000001", name: "Test Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "ai.scionbase.testwallet" };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  });
  return w;
}
