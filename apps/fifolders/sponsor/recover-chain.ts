// Real-chain RecoveryChain for recover.ts: a hot wallet on Calibration or mainnet. The key is never logged.
import { createWalletClient, erc20Abi, getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { waitForReceipt } from "../src/receipt.js";
import { chainFor, publicClient, SponsorWalletRelayer, type SponsorNetwork } from "./relayer.js";
import { factoryAdminAbi, type RecoveryChain } from "./recoverlib.js";
import { sweepAccount } from "./sweeplib.js";

export function evmRecoveryChain(input: { key: Hex; network: SponsorNetwork; rpc: string }): RecoveryChain {
  const { key, network, rpc } = input;
  const contracts = chainFor(network).contracts as unknown as Record<string, { address: Address }>;
  const usdfc = getAddress(contracts.usdfc!.address);
  const pub = publicClient({ network, rpc });
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: chainFor(network) as never, transport: http(rpc, { retryCount: 5 }) });
  const relayer = new SponsorWalletRelayer(key, { network, rpc });

  return {
    address: account.address,
    getBalance: (address) => pub.getBalance({ address }),
    usdfcBalance: (address) => pub.readContract({ address: usdfc, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    estimateGas: (tx) => pub.estimateGas({ account: account.address, ...tx } as never),
    async maxFeePerGas() {
      const fees = await pub.estimateFeesPerGas();
      return { maxFeePerGas: fees.maxFeePerGas!, maxPriorityFeePerGas: fees.maxPriorityFeePerGas! };
    },
    read: (fn, at) => pub.readContract({ address: at, abi: factoryAdminAbi, functionName: fn }),
    async send(tx) {
      const gas = tx.gas ?? ((await pub.estimateGas({ account: account.address, to: tx.to, data: tx.data, value: tx.value ?? 0n } as never)) * 13n) / 10n;
      const hash = (await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n, gas, ...(tx.maxFeePerGas ? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : {}) } as never)) as Hex;
      const receipt = await waitForReceipt(pub, hash);
      if (receipt.status !== "success") throw new Error(`${tx.label} reverted: ${hash}`);
      return hash;
    },
    sweep: (a) => sweepAccount(pub, relayer, a, network),
  };
}
