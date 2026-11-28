/**
 * A member's encryption key pair, derived from a deterministic wallet signature.
 *
 * Wallets no longer expose an encryption key (MetaMask deprecated `eth_getEncryptionPublicKey`), and Keysmith
 * grants and claims need a key the holder can use directly: grants are wrapped with ECDH on secp256k1, and a
 * claim's bearer signs each Curio request. So each member signs one fixed EIP-712 message; the signature is
 * hashed into a secp256k1 private key. The public key (and its address) go in the member's TrePerson profile;
 * a group admin wraps the shared folder key to it and names its address as the claim bearer and the
 * SessionKeyRegistry session key. Only the wallet holder can derive the private half again, on any device.
 *
 * secp256k1 rather than X25519: it is what Keysmith wraps to and what Curio verifies bearer signatures with.
 * Requires an RFC 6979 (deterministic) signer; the derivation signs twice and refuses a signer that differs.
 */
import { concat, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicKeyOf } from "@filoz/keysmith";

export const MEMBER_KEY_PURPOSE = "Unlock FiPerson shared folders on this device. This does not send a transaction or cost anything.";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export function memberKeyTypedData(owner: Address, chainId: number) {
  return {
    domain: { name: "FiPerson", version: "1", chainId },
    types: { MemberKey: [{ name: "owner", type: "address" }, { name: "purpose", type: "string" }] },
    primaryType: "MemberKey" as const,
    message: { owner: getAddress(owner), purpose: MEMBER_KEY_PURPOSE },
  };
}

export interface MemberKey {
  privateKey: Hex;
  /** Keysmith wrap key (publish this in TrePerson; admins wrap the folder key to it). */
  wrapKey: Hex;
  address: Address;
}

export function memberKeyFromSignature(signature: Hex): MemberKey {
  for (let counter = 0; counter < 256; counter++) {
    const candidate = BigInt(keccak256(concat([toHex("fiperson/member-key/v1"), signature, toHex(counter, { size: 1 })])));
    if (candidate === 0n || candidate >= N) continue;
    const privateKey = toHex(candidate, { size: 32 });
    const account = privateKeyToAccount(privateKey);
    return { privateKey, wrapKey: publicKeyOf(privateKey), address: account.address };
  }
  throw new Error("could not derive a member key");
}

export async function deriveMemberKey(wallet: { address: Address; signTypedData: (args: any) => Promise<Hex> }, chainId: number, opts: { verify?: boolean } = {}): Promise<MemberKey> {
  const args = memberKeyTypedData(wallet.address, chainId);
  const first = await wallet.signTypedData(args);
  if (opts.verify ?? true) {
    const second = await wallet.signTypedData(args);
    if (first.toLowerCase() !== second.toLowerCase()) {
      throw new Error("This wallet does not sign deterministically, so it cannot hold a member key.");
    }
  }
  return memberKeyFromSignature(first);
}
