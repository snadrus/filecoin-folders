import { custom, http, type EIP1193RequestFn } from "viem";
import { withTransientRetry } from "fil-folders";

/** Methods only the wallet can answer (accounts, signing, sending, wallet_*). Everything else is a chain read. */
const WALLET_METHOD = /^(eth_(requestAccounts|accounts|sendTransaction|sign|signTransaction|signTypedData(_v\d)?)|personal_sign|wallet_.*)$/;

export function isWalletMethod(method: string): boolean {
  return WALLET_METHOD.test(method);
}

/**
 * A wallet transport whose chain reads go to the public RPC (with the lagging-node retry), not the
 * wallet. MetaMask turns any upstream hiccup into an opaque -32603 "Internal JSON-RPC error", and
 * routing every SDK read through it stalls onboarding.
 */
export function walletWithPublicReads(provider: { request: EIP1193RequestFn | ((args: any) => Promise<unknown>) }, rpcUrl: string, retryCount?: number) {
  const reads = withTransientRetry(http(rpcUrl), { maxWaitMs: 20_000 })({ retryCount: 1 } as never);
  return custom(
    {
      request: (args: { method: string; params?: unknown }) =>
        isWalletMethod(args.method) ? (provider.request as (a: unknown) => Promise<unknown>)(args) : reads.request(args as never),
    },
    retryCount === undefined ? undefined : { retryCount },
  );
}
