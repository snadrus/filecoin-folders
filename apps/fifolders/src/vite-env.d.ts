/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_E2E?: string;
  readonly VITE_FELARUMI_URL?: string;
  readonly VITE_FELANUMIO_URL?: string;
  readonly VITE_FOLDER_REGISTRY?: string;
  readonly VITE_REGISTRY_FROM_BLOCK?: string;
  readonly VITE_FOLDER_REGISTRY_MAINNET?: string;
  readonly VITE_REGISTRY_FROM_BLOCK_MAINNET?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface Window {
  ethereum?: Eip1193Provider;
}

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
}
