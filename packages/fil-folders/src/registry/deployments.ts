import type { Address } from "viem";

/** FolderRegistry v1 on Filecoin Calibration (deployments/calibration.json). Still the encryption key domain. */
export const CALIBRATION_REGISTRY_V1 = "0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331" as const;
export const CALIBRATION_REGISTRY_V1_FROM_BLOCK = 4207373n;
/** FolderRegistry v2 on Filecoin Calibration (deployments/calibration-v2.json): minimal events, version CAS. */
export const CALIBRATION_REGISTRY_V2 = "0x9C06335D7DE588Caa104ee4FC3bb7cd8Aba62443" as const;
export const CALIBRATION_REGISTRY_V2_FROM_BLOCK = 4211744n;

/** v1 address → its v2 successor. `createViemRegistry` on a v1 address reads v2 first and migrates on the next commit. */
export const REGISTRY_SUCCESSORS: Record<string, { address: Address; fromBlock: bigint }> = {
  [CALIBRATION_REGISTRY_V1.toLowerCase()]: { address: CALIBRATION_REGISTRY_V2, fromBlock: CALIBRATION_REGISTRY_V2_FROM_BLOCK },
};
