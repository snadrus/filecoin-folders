import { getAddress, hashTypedData, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SPONSOR_REQUEST_TYPES, sponsorDomain, stableJson, type SponsorAuth } from "./abi.js";
import { readNetworkPreference, type ChainChoice } from "./config.js";
import { sponsorCall } from "./http.js";

export type SponsorTyped = {
  domain: ReturnType<typeof sponsorDomain>;
  types: typeof SPONSOR_REQUEST_TYPES;
  primaryType: "SponsorRequest";
  message: { action: string; bodyHash: Hex; issuedAt: bigint };
};

/** Signs sponsor requests as the account owner, a session key of the account, or a passkey. */
export interface SponsorSigner {
  auth(chainId: number, action: string, body: Record<string, unknown>): Promise<SponsorAuth>;
}

export function sponsorRequestTyped(
  chainId: number,
  action: string,
  body: Record<string, unknown>,
  issuedAt = BigInt(Math.floor(Date.now() / 1000)),
): SponsorTyped {
  return { domain: sponsorDomain(chainId), types: SPONSOR_REQUEST_TYPES, primaryType: "SponsorRequest", message: { action, bodyHash: keccak256(stringToHex(stableJson(body))), issuedAt } };
}

/** Owner wallet (EIP-712 prompt). */
export function walletSponsorSigner(address: Address, sign: (typed: SponsorTyped) => Promise<Hex>): SponsorSigner {
  return {
    async auth(chainId, action, body) {
      const typed = sponsorRequestTyped(chainId, action, body);
      return { kind: "eoa", address, issuedAt: typed.message.issuedAt.toString(), signature: await sign(typed) };
    },
  };
}

/** Browser session key registered on the account (no prompt). */
export function sessionSponsorSigner(account: Address, sessionKey: Hex): SponsorSigner {
  const local = privateKeyToAccount(sessionKey);
  return {
    async auth(chainId, action, body) {
      const typed = sponsorRequestTyped(chainId, action, body);
      return { kind: "session", account, key: local.address, issuedAt: typed.message.issuedAt.toString(), signature: await local.signTypedData(typed) };
    },
  };
}

/** Passkey owner: the WebAuthn challenge is the SponsorRequest digest. */
export function passkeySponsorSigner(
  key: { x: Hex; y: Hex; credentialId?: string },
  assert: (challenge: Hex) => Promise<{ authenticatorData: Hex; clientDataJSON: string; signature: Hex }>,
): SponsorSigner {
  return {
    async auth(chainId, action, body) {
      const typed = sponsorRequestTyped(chainId, action, body);
      return { kind: "passkey", x: key.x, y: key.y, ...(key.credentialId ? { credentialId: key.credentialId } : {}), issuedAt: typed.message.issuedAt.toString(), ...(await assert(hashTypedData(typed))) };
    },
  };
}

/** The user's sponsored payer account, or null before the sponsor created it. */
export async function findSponsoredAccount(user: Address, chain?: ChainChoice): Promise<Address | null> {
  const out = await sponsorCall<{ account: Address | null }>(`/account?user=${user}`, undefined, chain ?? readNetworkPreference());
  return out.account ? getAddress(out.account) : null;
}

/** Passkey owner's account, or null before the first purchase. */
export async function findPasskeyAccount(key: { x: Hex; y: Hex }, chain?: ChainChoice): Promise<Address | null> {
  const out = await sponsorCall<{ account: Address | null }>(`/account?x=${key.x}&y=${key.y}`, undefined, chain ?? readNetworkPreference());
  return out.account ? getAddress(out.account) : null;
}

/** Public key of a passkey the sponsor has seen (recorded at its first purchase), by WebAuthn credential id. */
export async function findPasskeyByCredential(credentialId: string, chain?: ChainChoice): Promise<{ x: Hex; y: Hex } | null> {
  const out = await sponsorCall<{ account: Address | null; x?: Hex; y?: Hex }>(`/account?credential=${encodeURIComponent(credentialId)}`, undefined, chain ?? readNetworkPreference());
  return out.account && out.x && out.y ? { x: out.x, y: out.y } : null;
}
