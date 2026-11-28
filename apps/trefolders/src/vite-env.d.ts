/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_E2E?: string;
  readonly VITE_TREPEN_URL?: string;
  readonly VITE_TREGRID_URL?: string;
  readonly VITE_FELARUMI_URL?: string;
  readonly VITE_FELANUMIO_URL?: string;
  readonly VITE_FOLDER_REGISTRY?: string;
  readonly VITE_REGISTRY_FROM_BLOCK?: string;
  readonly VITE_FOLDER_REGISTRY_MAINNET?: string;
  readonly VITE_REGISTRY_FROM_BLOCK_MAINNET?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_TRECLUB_ADDRESS_CALIBRATION?: string;
  readonly VITE_TRECLUB_ADDRESS_MAINNET?: string;
  readonly VITE_TRECLUB_ADDRESS_LOCAL?: string;
  readonly VITE_TRECLUB_RPC?: string;
  readonly VITE_TRECLUB_CHAIN_ID?: string;
  /** Gasless mode: sponsor backend URL (apps/trefolders/sponsor). */
  readonly VITE_SPONSOR_URL?: string;
  readonly VITE_SPONSOR_NETWORKS?: string;
  readonly VITE_STRIPE_PUBLISHABLE_KEY_MAINNET?: string;
  readonly VITE_SPONSOR_CREDIT_USD?: string;
  readonly VITE_STRIPE_PUBLISHABLE_KEY?: string;
}

interface Window {
  ethereum?: Eip1193Provider;
}

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
}
