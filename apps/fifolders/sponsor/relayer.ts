// Relayer: anything that can get a call on chain and pay its gas (from /workspace/fil-gasless/e2e/relayer.ts).
// SponsorWalletRelayer is a self-hosted hot wallet. A Goldsky (or Gelato) backend would implement the same interface.
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { calibration, mainnet } from "@filoz/synapse-core/chains";
import { jsonRpc, receiptRpcUrls, waitForReceipt } from "../src/receipt.js";

export interface RelayCall {
  to?: Address;
  data: Hex;
  value?: bigint;
  /** Skip eth_estimateGas when set (Filecoin estimates can be slow; use a padded known limit). */
  gas?: bigint;
  label: string;
}

export type PendingRelay = {
  label: string;
  hash: Hex;
  nonce: number;
  gas: bigint;
  to?: Address;
  data: Hex;
  value: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export interface Relayer {
  readonly name: string;
  readonly address: Address;
  /** Submit and return the hash without waiting. */
  send(call: RelayCall): Promise<Hex>;
  /** Submit and wait; throws on revert. */
  relay(call: RelayCall): Promise<TransactionReceipt>;
  /** Same nonce, bumped fees; used when a broadcast tx is not included in time. */
  replace?(hash: Hex, bumpBps?: number): Promise<Hex>;
}

export type SponsorNetwork = "calibration" | "mainnet";
export interface ChainOptions {
  network?: SponsorNetwork;
  rpc?: string;
}

// Node reads process.env; the Worker passes options explicitly.
const ENV: Record<string, string | undefined> = typeof process !== "undefined" && process.env ? process.env : {};
export const NETWORK: SponsorNetwork = ENV.SPONSOR_NETWORK === "mainnet" ? "mainnet" : "calibration";

export function chainFor(network: SponsorNetwork = NETWORK) {
  return network === "mainnet" ? mainnet : calibration;
}

export function rpcFor(network: SponsorNetwork = NETWORK, override?: string): string {
  if (override) return override;
  if (network === "mainnet") return ENV.SPONSOR_RPC ?? ENV.MAINNET_RPC ?? "https://api.node.glif.io/rpc/v1";
  return ENV.SPONSOR_RPC ?? ENV.CALIBRATION_RPC ?? "https://api.calibration.node.glif.io/rpc/v1";
}

export const CHAIN = chainFor(NETWORK);
export const RPC = rpcFor(NETWORK);

export function publicClient(opts: ChainOptions = {}): PublicClient {
  const network = opts.network ?? NETWORK;
  return createPublicClient({ chain: chainFor(network) as never, transport: http(rpcFor(network, opts.rpc), { retryCount: 1, timeout: 8_000 }) }) as unknown as PublicClient;
}

export class SponsorWalletRelayer implements Relayer {
  readonly name = "sponsor-hot-wallet";
  readonly address: Address;
  private wallet;
  private pub: PublicClient;
  /** Every submission, for audit logs. */
  readonly sent: { label: string; hash: Hex }[] = [];
  /** One sender, one nonce sequence: serialize submissions. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Local pending nonce so back-to-back sends do not wait for a getTransaction round trip. */
  private nextNonce: number | undefined;
  /** Broadcast txs that have not been replaced, keyed by lower-case hash. */
  private pending = new Map<string, PendingRelay>();

  private network: SponsorNetwork;
  private rpcUrl: string;

  constructor(privateKey: Hex, opts: ChainOptions = {}) {
    const account = privateKeyToAccount(privateKey);
    const network = opts.network ?? NETWORK;
    this.network = network;
    this.rpcUrl = rpcFor(network, opts.rpc);
    this.address = account.address;
    this.pub = publicClient(opts);
    this.wallet = createWalletClient({ account, chain: chainFor(network) as never, transport: http(this.rpcUrl, { retryCount: 1, timeout: 8_000 }) });
  }

  send(call: RelayCall): Promise<Hex> {
    const next = this.queue.then(async () => {
      const started = Date.now();
      let estimateMs = 0;
      let gas = call.gas;
      if (gas == null) {
        const t0 = Date.now();
        // FEVM estimates run tight (a relayed terminateService ran out of gas at the estimate): add 30%.
        const estimate = await this.pub.estimateGas({ account: this.address, to: call.to ?? undefined, data: call.data, value: call.value ?? 0n } as never);
        estimateMs = Date.now() - t0;
        gas = (estimate * 13n) / 10n;
      }
      const tFee = Date.now();
      const [nonce, fees] = await Promise.all([
        this.nextNonce == null
          ? this.pub.getTransactionCount({ address: this.address, blockTag: "pending" }).then((n) => Number(n))
          : Promise.resolve(this.nextNonce),
        this.fees(),
      ]);
      const feeMs = Date.now() - tFee;
      const tSend = Date.now();
      const signed = await this.wallet.signTransaction({
        type: "eip1559",
        to: call.to ?? null,
        data: call.data,
        value: call.value ?? 0n,
        gas,
        nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      } as never);
      const urls = receiptRpcUrls(this.network, this.rpcUrl);
      const hash = await this.broadcastRaw(signed, urls);
      const sendMs = Date.now() - tSend;
      this.nextNonce = nonce + 1;
      this.pending.set(hash.toLowerCase(), {
        label: call.label,
        hash,
        nonce,
        gas,
        to: call.to,
        data: call.data,
        value: call.value ?? 0n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      console.log(`[relay:${this.name}] ${call.label}: ${hash}`);
      console.log(`[relay-timing] ${JSON.stringify({ label: call.label, hash, estimateMs, feeMs, sendMs, totalMs: Date.now() - started, gas: gas.toString(), nonce })}`);
      this.sent.push({ label: call.label, hash });
      if (this.sent.length > 500) this.sent.splice(0, this.sent.length - 500);
      return hash;
    });
    this.queue = next.catch(() => {
      this.nextNonce = undefined;
    });
    return next;
  }

  async relay(call: RelayCall): Promise<TransactionReceipt> {
    const hash = await this.send(call);
    const receipt = await waitForReceipt(this.pub, hash, { rpcUrls: receiptRpcUrls(this.network, this.rpcUrl) });
    if (receipt.status !== "success") throw new Error(`${call.label} reverted: ${hash}`);
    this.pending.delete(hash.toLowerCase());
    return receipt;
  }

  async replace(hash: Hex, bumpBps = 2_500): Promise<Hex> {
    const next = this.queue.then(async () => {
      const prev = this.pending.get(hash.toLowerCase());
      if (!prev) throw new Error(`no pending tx to replace: ${hash}`);
      const bump = (value: bigint) => value + (value * BigInt(bumpBps)) / 10_000n + 1n;
      const maxFeePerGas = bump(prev.maxFeePerGas);
      const maxPriorityFeePerGas = bump(prev.maxPriorityFeePerGas);
      const signed = await this.wallet.signTransaction({
        type: "eip1559",
        to: prev.to ?? null,
        data: prev.data,
        value: prev.value,
        gas: prev.gas,
        nonce: prev.nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
      } as never);
      const urls = receiptRpcUrls(this.network, this.rpcUrl);
      const nextHash = await this.broadcastRaw(signed, urls);
      this.pending.delete(hash.toLowerCase());
      this.pending.set(nextHash.toLowerCase(), { ...prev, hash: nextHash, maxFeePerGas, maxPriorityFeePerGas });
      this.sent.push({ label: `${prev.label} (rebroadcast)`, hash: nextHash });
      console.log(`[relay:${this.name}] rebroadcast ${prev.label}: ${hash} -> ${nextHash} nonce=${prev.nonce}`);
      return nextHash;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Pad current tip so we skip a slow fee-oracle round trip inside sendTransaction and still clear the next tipset. */
  private async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const block = await this.pub.getBlock({ blockTag: "latest" });
    const base = block.baseFeePerGas ?? 0n;
    // Generous pad over base so we still clear the next tipset without a second fee-oracle round trip.
    const maxPriorityFeePerGas = (base > 0n ? base : 100_000n) + 500_000n;
    return { maxFeePerGas: base * 4n + maxPriorityFeePerGas, maxPriorityFeePerGas };
  }

  /** Sign once, then race eth_sendRawTransaction across fallback RPCs so a slow Glif POST does not stall the batch. */
  private async broadcastRaw(raw: Hex, urls: string[]): Promise<Hex> {
    const sendOne = async (url: string) => {
      const hash = await jsonRpc<Hex>(url, "eth_sendRawTransaction", [raw], { timeoutMs: 8_000 });
      if (typeof hash !== "string" || !hash.startsWith("0x")) throw new Error(`bad send hash from ${new URL(url).host}`);
      console.log(`[relay-timing] broadcast ok host=${new URL(url).host} hash=${hash}`);
      return hash;
    };
    try {
      return await Promise.any(urls.map(sendOne));
    } catch (error) {
      const detail = error instanceof AggregateError ? error.errors.map((item) => (item instanceof Error ? item.message : String(item))).join("; ") : error;
      throw new Error(`broadcast failed: ${detail}`);
    }
  }
}

// Goldsky Compose sponsors gas only through ERC-4337 / EIP-7702 smart wallets, and Compose does not list Filecoin
// (docs.goldsky.com/chains/supported-networks). Placeholder until it does; the server takes any Relayer.
export class GoldskyComposeRelayer implements Relayer {
  readonly name = "goldsky-compose";
  readonly address: Address = "0x0000000000000000000000000000000000000000";
  async send(_call: RelayCall): Promise<Hex> {
    throw new Error("Goldsky Compose has no Filecoin support and no gas sponsorship without ERC-4337/7702 on FEVM");
  }
  async relay(_call: RelayCall): Promise<TransactionReceipt> {
    throw new Error("Goldsky Compose has no Filecoin support and no gas sponsorship without ERC-4337/7702 on FEVM");
  }
}
