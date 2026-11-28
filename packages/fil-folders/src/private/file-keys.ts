/**
 * Per-file keys for private volumes.
 *
 * A private volume's commit pieces are FEE envelopes (so Curio gates them), but one piece can hold
 * the manifest and several files. To share a single file without revealing the rest, every file in a
 * private volume is AES-256-GCM encrypted under its own key, derived one-way from the volume key and
 * the file's random IV: `HKDF-SHA256(volumeKey, salt = "fil-folders-file-key/v1", info = iv)`.
 * Handing out one file key reveals nothing about the volume key, the names or the other files.
 */
import { asBuffer, base64ToBytes } from "../bytes.js";

const SALT = new TextEncoder().encode("fil-folders-file-key/v1");
const VOLUME_INFO = new TextEncoder().encode("fil-folders/private-volume-key/v1");

async function hkdf(raw: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", asBuffer(raw), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: asBuffer(salt), info: asBuffer(info) }, material, 256));
}

/** The 32-byte volume key of a private volume, from the Keysmith key of the volume's group. */
export async function volumeKeyFromGroupKey(groupNodeKey: Uint8Array): Promise<Uint8Array> {
  if (groupNodeKey.byteLength !== 32) throw new Error("A group key is 32 bytes.");
  return hkdf(groupNodeKey, SALT, VOLUME_INFO);
}

/** Raw 32-byte key for one file, from the volume key and the file's base64 IV. */
export async function fileKeyBytes(volumeKey: Uint8Array, iv: string): Promise<Uint8Array> {
  return hkdf(volumeKey, SALT, base64ToBytes(iv));
}

export async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", asBuffer(raw), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
