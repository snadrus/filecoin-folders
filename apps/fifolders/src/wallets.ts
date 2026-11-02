import type { ChainChoice } from "./session.js";

export const WALLETCONNECT_RDNS = "walletconnect";
export const DEFAULT_WALLETCONNECT_PROJECT_ID = "6d8b88b03b08df309b5258ff3de372be";

const CHAIN_ID: Record<ChainChoice, number> = { mainnet: 314, calibration: 314159 };

export interface WalletChoice {
  rdns: string;
  name: string;
}

export function walletConnectProjectId(env: { VITE_WALLETCONNECT_PROJECT_ID?: string } = import.meta.env): string {
  return env.VITE_WALLETCONNECT_PROJECT_ID?.trim() || DEFAULT_WALLETCONNECT_PROJECT_ID;
}

/** Named EIP-6963 wallets, plus WalletConnect. Legacy injection stays only when nothing else announced. */
export function walletChoices(announced: readonly WalletChoice[]): WalletChoice[] {
  const named = announced.filter((wallet) => wallet.rdns && wallet.rdns !== "window.ethereum");
  const base = named.length ? named : announced.filter((wallet) => wallet.rdns);
  const rest = base.filter((wallet) => wallet.rdns !== WALLETCONNECT_RDNS);
  return [...rest, { rdns: WALLETCONNECT_RDNS, name: "WalletConnect" }];
}

export function walletConnectConfig(origin: string, network: ChainChoice, projectId = walletConnectProjectId()) {
  return {
    projectId,
    chains: [CHAIN_ID[network]] as [number],
    optionalChains: [CHAIN_ID.mainnet, CHAIN_ID.calibration] as [number, number],
    showQrModal: true,
    metadata: {
      name: "FiFolders",
      description: "A folder volume on Filecoin.",
      url: origin,
      icons: [`${origin}/favicon.svg`],
    },
  };
}

export interface WalletConnectLike {
  session?: { expiry?: number } | null;
  accounts?: string[];
  request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  connect?: (options: { chains: number[]; optionalChains: number[] }) => Promise<void>;
}

/** Restore an existing session without pairing again. */
export async function connectWalletConnect(input: {
  network: ChainChoice;
  origin: string;
  init: (config: ReturnType<typeof walletConnectConfig>) => Promise<WalletConnectLike>;
}): Promise<{ provider: WalletConnectLike; address: string }> {
  const provider = await input.init(walletConnectConfig(input.origin, input.network));
  const expiry = provider.session?.expiry;
  const live = Boolean(provider.session) && (expiry === undefined || expiry > Date.now() / 1000);
  if (!live) {
    await provider.connect?.({
      chains: [CHAIN_ID[input.network]],
      optionalChains: [CHAIN_ID[input.network === "mainnet" ? "calibration" : "mainnet"]],
    });
  }
  const accounts =
    provider.accounts ??
    ((await provider.request?.({ method: "eth_accounts" })) as string[] | undefined) ??
    [];
  const address = accounts[0];
  if (!address) throw new Error("WalletConnect did not return an account.");
  return { provider, address };
}
