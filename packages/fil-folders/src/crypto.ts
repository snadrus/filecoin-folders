import { type Address, type Hex, hexToBytes } from "viem";
import { asBuffer, base64ToBytes, bytesToBase64 } from "./bytes.js";
import type { EncryptionSigner } from "./types.js";

/** Domain-separating string signed into the volume key. */
export const VOLUME_KEY_PURPOSE = "fil-folders volume key v1";

export const FILE_AAD = "fil-folders-file";
export const NAME_AAD = "fil-folders-name";

const encoder = new TextEncoder();

export async function signVolumeKey(options: {
  mode: "eip712" | "personal_sign";
  signer: EncryptionSigner;
  chainId: number;
  registryAddress: Address;
  owner: Address;
  volume: string;
}): Promise<Hex> {
  if (options.mode === "personal_sign") {
    if (!options.signer.signMessage) throw new Error("encryption signer has no signMessage");
    const message = [
      VOLUME_KEY_PURPOSE,
      `chainId:${options.chainId}`,
      `registry:${options.registryAddress.toLowerCase()}`,
      `owner:${options.owner.toLowerCase()}`,
      `volume:${options.volume}`,
    ].join("\n");
    return options.signer.signMessage({ message });
  }
  if (!options.signer.signTypedData) throw new Error("encryption signer has no signTypedData");
  return options.signer.signTypedData({
    domain: {
      name: "Filecoin Folders",
      version: "1",
      chainId: options.chainId,
      verifyingContract: options.registryAddress,
    },
    types: {
      VolumeKey: [
        { name: "owner", type: "address" },
        { name: "volume", type: "string" },
        { name: "purpose", type: "string" },
      ],
    },
    primaryType: "VolumeKey",
    message: {
      owner: options.owner,
      volume: options.volume,
      purpose: VOLUME_KEY_PURPOSE,
    },
  });
}

export function volumeKeyInfo(options: {
  mode: "eip712" | "personal_sign";
  chainId: number;
  registryAddress: Address;
  owner: Address;
  volume: string;
}): string {
  return [
    "fil-folders",
    options.mode,
    String(options.chainId),
    options.registryAddress.toLowerCase(),
    options.owner.toLowerCase(),
    options.volume,
  ].join("/");
}

/** HKDF-SHA256 from a 65-byte wallet signature to an AES-256-GCM key. */
export async function deriveVolumeKey(signature: Hex, info: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", asBuffer(hexToBytes(signature)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("fil-folders-v1"),
      info: encoder.encode(info),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptBytes(
  key: CryptoKey,
  plain: Uint8Array,
  aad: string,
): Promise<{ ciphertext: Uint8Array; iv: string }> {
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: ivBytes, additionalData: encoder.encode(aad) },
      key,
      asBuffer(plain),
    ),
  );
  return { ciphertext, iv: bytesToBase64(ivBytes) };
}

export async function decryptBytes(key: CryptoKey, ciphertext: Uint8Array, iv: string, aad: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: asBuffer(base64ToBytes(iv)), additionalData: encoder.encode(aad) },
        key,
        asBuffer(ciphertext),
      ),
    );
  } catch {
    throw new Error("decryption failed");
  }
}
