/**
 * The one widening for private folders (Andy, 2026-11-28): POST /dataset may open a `read=restricted` data set for
 * the signed-in user's own sponsored account. The request may carry exactly these private keys, with these shapes:
 *
 *   read      = "restricted"
 *   foc/enc   = "1"
 *   foc/gkid  = 0x + 32 lowercase hex   (Keysmith group key id)
 *   foc/kc    = "v2." + 32 lowercase hex (group key commitment)
 *
 * plus the descriptive keys the app always sent (app, volume, created), which the sponsor still ignores and replaces
 * with its own. Any other key, or any other value, is refused. The sponsor never sees a key: the commitment is a hash.
 */
export const PRIVATE_DATASET_KEYS = ["read", "foc/enc", "foc/gkid", "foc/kc"] as const;
/** Keys the client has always sent and the sponsor ignores (it writes its own app/volume/created). */
export const IGNORED_DATASET_KEYS = ["app", "volume", "created"] as const;
/** Lifetime cap per account, so a session key cannot open data sets without end (each one is a sponsor-paid tx). */
export const MAX_PRIVATE_DATASETS = 3;

export type PrivateDatasetMetadata = { read: "restricted"; "foc/enc": "1"; "foc/gkid": string; "foc/kc": string };

export class DatasetMetadataError extends Error {}

/**
 * Validate the `metadata` a client sent to POST /dataset. Returns the private keys for a private request, or null for
 * a public one (only ignored descriptive keys, or nothing). Throws {@link DatasetMetadataError} for anything else.
 */
export function parseDatasetRequestMetadata(raw: unknown): PrivateDatasetMetadata | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new DatasetMetadataError("metadata must be an object");
  const entries = Object.entries(raw as Record<string, unknown>);
  const allowed = new Set<string>([...PRIVATE_DATASET_KEYS, ...IGNORED_DATASET_KEYS]);
  for (const [key, value] of entries) {
    if (!allowed.has(key)) throw new DatasetMetadataError(`metadata key not allowed: ${key.slice(0, 40)}`);
    if (typeof value !== "string" || value.length > 128) throw new DatasetMetadataError(`metadata value not allowed: ${key}`);
  }
  const m = raw as Record<string, string>;
  const privateKeys = PRIVATE_DATASET_KEYS.filter((key) => key in m);
  if (!privateKeys.length) return null;
  if (privateKeys.length !== PRIVATE_DATASET_KEYS.length) throw new DatasetMetadataError("a private data set needs read, foc/enc, foc/gkid and foc/kc");
  if (m.read !== "restricted") throw new DatasetMetadataError("metadata value not allowed: read");
  if (m["foc/enc"] !== "1") throw new DatasetMetadataError("metadata value not allowed: foc/enc");
  if (!/^0x[0-9a-f]{32}$/.test(m["foc/gkid"]!)) throw new DatasetMetadataError("metadata value not allowed: foc/gkid");
  if (!/^v2\.[0-9a-f]{32}$/.test(m["foc/kc"]!)) throw new DatasetMetadataError("metadata value not allowed: foc/kc");
  return { read: "restricted", "foc/enc": "1", "foc/gkid": m["foc/gkid"]!, "foc/kc": m["foc/kc"]! };
}
