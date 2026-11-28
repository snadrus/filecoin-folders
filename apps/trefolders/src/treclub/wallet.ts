import { getAddress, type Address } from "viem";
import { discoverWallets } from "../eip6963.js";
import { INTENTS, watchWalletPrompts, withWalletIntent } from "../wallet-prompts.js";

export type Provider = { request(args: { method: string; params?: unknown }): Promise<unknown> };

let cached: Provider | null = null;

export async function getProvider(): Promise<Provider> {
  if (cached) return cached;
  const wallets = await discoverWallets().catch(() => []);
  const raw = (wallets[0]?.provider as Provider | undefined) ?? (window as unknown as { ethereum?: Provider }).ethereum;
  if (!raw) throw new Error("No browser wallet found. Install one such as MetaMask.");
  cached = watchWalletPrompts(raw);
  return cached;
}

export async function peekAccount(): Promise<Address | null> {
  try {
    const a = (await (await getProvider()).request({ method: "eth_accounts" })) as string[];
    return a?.[0] ? getAddress(a[0]) : null;
  } catch {
    return null;
  }
}

export async function connectAccount(): Promise<Address> {
  const p = await getProvider();
  const a = (await withWalletIntent(INTENTS.connect, () => p.request({ method: "eth_requestAccounts" }))) as string[];
  if (!a?.[0]) throw new Error("The wallet returned no account.");
  return getAddress(a[0]);
}
