// Relayer: anything that can get a call on chain and pay its gas (from /workspace/fil-gasless/e2e/relayer.ts).
// SponsorWalletRelayer is a self-hosted hot wallet. A Goldsky (or Gelato) backend would implement the same interface.
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { calibration, mainnet } from "@filoz/synapse-core/chains";

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

export const NETWORK: "calibration" | "mainnet" = process.env.SPONSOR_NETWORK === "mainnet" ? "mainnet" : "calibration";
export const CHAIN = NETWORK === "mainnet" ? mainnet : calibration;
export const RPC = process.env.SPONSOR_RPC ?? process.env.CALIBRATION_RPC ?? (NETWORK === "mainnet" ? "https://api.node.glif.io/rpc/v1" : "https://api.calibration.node.glif.io/rpc/v1");

export function publicClient(): PublicClient {
  return createPublicClient({ chain: CHAIN as never, transport: http(RPC, { retryCount: 5 }) }) as unknown as PublicClient;
}

export class SponsorWalletRelayer implements Relayer {
  readonly name = "sponsor-hot-wallet";
  readonly address: Address;
  private wallet;
  private pub = publicClient();
  /** Every submission, for audit logs. */
  readonly sent: { label: string; hash: Hex }[] = [];
  /** One sender, one nonce sequence: serialize submissions. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(privateKey: Hex) {
    const account = privateKeyToAccount(privateKey);
    this.address = account.address;
    this.wallet = createWalletClient({ account, chain: CHAIN as never, transport: http(RPC, { retryCount: 5 }) });
  }

  send(call: RelayCall): Promise<Hex> {
    const next = this.queue.then(async () => {
      const hash = (await this.wallet.sendTransaction({ to: call.to ?? null, data: call.data, value: call.value ?? 0n } as never)) as Hex;
      console.log(`[relay:${this.name}] ${call.label}: ${hash}`);
      this.sent.push({ label: call.label, hash });
      // FEVM: wait until the node has the tx so the next nonce read is fresh.
      await this.pub.getTransaction({ hash }).catch(() => undefined);
      return hash;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async relay(call: RelayCall): Promise<TransactionReceipt> {
    const hash = await this.send(call);
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 10 * 60_000, pollingInterval: 5_000 });
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
