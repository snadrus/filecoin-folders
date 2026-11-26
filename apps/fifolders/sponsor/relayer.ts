// Relayer: anything that can get a call on chain and pay its gas (from /workspace/fil-gasless/e2e/relayer.ts).
// SponsorWalletRelayer is a self-hosted hot wallet. A Goldsky (or Gelato) backend would implement the same interface.
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { calibration, mainnet } from "@filoz/synapse-core/chains";
import { waitForReceipt } from "../src/receipt.js";

export interface RelayCall {
  to?: Address;
  data: Hex;
  value?: bigint;
  label: string;
}

export interface Relayer {
  readonly name: string;
  readonly address: Address;
  /** Submit and return the hash without waiting. */
  send(call: RelayCall): Promise<Hex>;
  /** Submit and wait; throws on revert. */
  relay(call: RelayCall): Promise<TransactionReceipt>;
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
  return override ?? ENV.SPONSOR_RPC ?? ENV.CALIBRATION_RPC ?? (network === "mainnet" ? "https://api.node.glif.io/rpc/v1" : "https://api.calibration.node.glif.io/rpc/v1");
}

export const CHAIN = chainFor(NETWORK);
export const RPC = rpcFor(NETWORK);

export function publicClient(opts: ChainOptions = {}): PublicClient {
  const network = opts.network ?? NETWORK;
  return createPublicClient({ chain: chainFor(network) as never, transport: http(rpcFor(network, opts.rpc), { retryCount: 5 }) }) as unknown as PublicClient;
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

  constructor(privateKey: Hex, opts: ChainOptions = {}) {
    const account = privateKeyToAccount(privateKey);
    const network = opts.network ?? NETWORK;
    this.address = account.address;
    this.pub = publicClient(opts);
    this.wallet = createWalletClient({ account, chain: chainFor(network) as never, transport: http(rpcFor(network, opts.rpc), { retryCount: 5 }) });
  }

  send(call: RelayCall): Promise<Hex> {
    const next = this.queue.then(async () => {
      // FEVM estimates run tight (a relayed terminateService ran out of gas at the estimate): add 30%.
      const estimate = await this.pub.estimateGas({ account: this.address, to: call.to ?? undefined, data: call.data, value: call.value ?? 0n } as never);
      const hash = (await this.wallet.sendTransaction({ to: call.to ?? null, data: call.data, value: call.value ?? 0n, gas: (estimate * 13n) / 10n } as never)) as Hex;
      console.log(`[relay:${this.name}] ${call.label}: ${hash}`);
      this.sent.push({ label: call.label, hash });
      if (this.sent.length > 500) this.sent.splice(0, this.sent.length - 500);
      // FEVM: wait until the node has the tx so the next nonce read is fresh.
      await this.pub.getTransaction({ hash }).catch(() => undefined);
      return hash;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async relay(call: RelayCall): Promise<TransactionReceipt> {
    const hash = await this.send(call);
    const receipt = await waitForReceipt(this.pub, hash);
    if (receipt.status !== "success") throw new Error(`${call.label} reverted: ${hash}`);
    return receipt;
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
