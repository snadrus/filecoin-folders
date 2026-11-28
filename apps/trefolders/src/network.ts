import type { ChainChoice } from "./session.js";

export const NETWORK_KEY = "fifolders:network";
export const REGISTRY_NOT_DEPLOYED = "Registry not deployed";

export function readNetworkPreference(): ChainChoice {
  try {
    const saved = localStorage.getItem(NETWORK_KEY);
    return saved === "mainnet" || saved === "calibration" ? saved : "calibration";
  } catch {
    return "calibration";
  }
}

export function saveNetworkPreference(chain: ChainChoice): void {
  try {
    localStorage.setItem(NETWORK_KEY, chain);
  } catch {
    // The selected network still works for this page when storage is unavailable.
  }
}

export function mainnetRegistryAddress(env: { VITE_FOLDER_REGISTRY_MAINNET?: string } = import.meta.env): string {
  return env.VITE_FOLDER_REGISTRY_MAINNET?.trim() ?? "";
}

export function registryReady(chain: ChainChoice, env: { VITE_FOLDER_REGISTRY_MAINNET?: string } = import.meta.env): boolean {
  if (chain !== "mainnet") return true;
  return mainnetRegistryAddress(env).length > 0;
}
