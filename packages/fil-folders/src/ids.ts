import { keccak256, stringToBytes, type Address, type Hex } from "viem";

/** Registry namespace string. The on-chain id is {@link namespaceId} of this value. */
export const FIL_FOLDERS_NAMESPACE = "fil-folders";

/** Matches `FolderRegistry.MAX_PIECE_CID_BYTES`. Piece CID strings are stored as UTF-8. */
export const PIECE_CID_MAX_BYTES = 128;

/** `keccak256(utf8(name))`. The default namespace is `fil-folders`. */
export function namespaceId(name: string = FIL_FOLDERS_NAMESPACE): Hex {
  return keccak256(stringToBytes(name));
}

/** `keccak256(utf8(volumeName))`. Volume names are not limited to 32 bytes. */
export function volumeKey(name: string): Hex {
  return keccak256(stringToBytes(name));
}

export function normalizeAddress(address: Address): Address {
  return address.toLowerCase() as Address;
}
