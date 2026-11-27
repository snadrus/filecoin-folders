interface ImportMetaEnv {
  readonly VITE_SPONSOR_URL?: string;
  readonly VITE_SPONSOR_NETWORKS?: string;
  readonly VITE_SPONSOR_CREDIT_USD?: string;
  readonly VITE_STRIPE_PUBLISHABLE_KEY?: string;
  readonly VITE_STRIPE_PUBLISHABLE_KEY_MAINNET?: string;
  readonly VITE_FOLDER_REGISTRY?: string;
  readonly VITE_REGISTRY_FROM_BLOCK?: string;
  readonly VITE_FOLDER_REGISTRY_MAINNET?: string;
  readonly VITE_REGISTRY_FROM_BLOCK_MAINNET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
