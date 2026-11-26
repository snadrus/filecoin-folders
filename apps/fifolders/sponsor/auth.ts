// Caller authentication: every state-changing sponsor request carries an EIP-712 SponsorRequest signed by the account
// owner (EOA), one of the account's live session keys, or the owner's passkey (WebAuthn P-256).
import { webcrypto } from "node:crypto";
import { getAddress, hashTypedData, hexToBytes, keccak256, recoverTypedDataAddress, stringToHex, type Address, type Hex } from "viem";
import { SPONSOR_REQUEST_TYPES, sponsorDomain, stableJson, type SponsorAuth } from "../src/sponsored-abi.js";

export const AUTH_MAX_AGE_SEC = 300;

export type Identity =
  | { kind: "eoa"; id: string; address: Address }
  | { kind: "passkey"; id: string; x: Hex; y: Hex; credentialId?: string }
  | { kind: "session"; id: string; account: Address; key: Address };

export function bodyHash(body: Record<string, unknown>): Hex {
  const { auth: _auth, ...rest } = body;
  return keccak256(stringToHex(stableJson(rest)));
}

export function requestDigest(chainId: number, action: string, body: Record<string, unknown>, issuedAt: bigint): Hex {
  return hashTypedData({ domain: sponsorDomain(chainId), types: SPONSOR_REQUEST_TYPES, primaryType: "SponsorRequest", message: { action, bodyHash: bodyHash(body), issuedAt } });
}

export function passkeyId(x: Hex, y: Hex): string {
  return `passkey:${x.toLowerCase()}:${y.toLowerCase()}`;
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** WebAuthn assertion over `challenge`: type webauthn.get, challenge match, user-present flag, P-256 signature (r||s). */
export async function verifyPasskeyAssertion(challenge: Hex, x: Hex, y: Hex, authenticatorData: Hex, clientDataJSON: string, signature: Hex): Promise<boolean> {
  let client: { type?: string; challenge?: string };
  try {
    client = JSON.parse(clientDataJSON);
  } catch {
    return false;
  }
  const auth = hexToBytes(authenticatorData);
  if (client.type !== "webauthn.get" || client.challenge !== b64url(hexToBytes(challenge)) || auth.length < 37 || (auth[32]! & 1) === 0) return false;
  const key = await webcrypto.subtle.importKey("raw", new Uint8Array([4, ...hexToBytes(x), ...hexToBytes(y)]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const clientHash = new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(clientDataJSON)));
  return webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, hexToBytes(signature), new Uint8Array([...auth, ...clientHash]));
}

export class AuthError extends Error {}

/**
 * Check `body.auth` for `action`. `sessionExpiry(account, key)` reads LockedSignerAccount.sessionSigners on chain.
 * Replays inside the freshness window are refused via `seen`.
 */
export async function verifyAuth(input: {
  chainId: number;
  action: string;
  body: Record<string, unknown>;
  sessionExpiry: (account: Address, key: Address) => Promise<bigint>;
  seen: Map<string, number>;
  nowSec?: number;
}): Promise<Identity> {
  const auth = input.body.auth as SponsorAuth | undefined;
  if (!auth || typeof auth !== "object") throw new AuthError("missing auth");
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const issuedAt = BigInt(auth.issuedAt ?? "0");
  if (issuedAt > BigInt(now + 60) || issuedAt < BigInt(now - AUTH_MAX_AGE_SEC)) throw new AuthError("stale auth");
  for (const [sig, at] of input.seen) if (at < now - AUTH_MAX_AGE_SEC - 60) input.seen.delete(sig);
  if (input.seen.has(auth.signature)) throw new AuthError("replayed auth");
  const digest = requestDigest(input.chainId, input.action, input.body, issuedAt);
  let identity: Identity;
  if (auth.kind === "passkey") {
    if (!(await verifyPasskeyAssertion(digest, auth.x, auth.y, auth.authenticatorData, auth.clientDataJSON, auth.signature))) throw new AuthError("bad passkey signature");
    identity = { kind: "passkey", id: passkeyId(auth.x, auth.y), x: auth.x, y: auth.y, ...(typeof auth.credentialId === "string" && /^[A-Za-z0-9_-]{8,512}$/.test(auth.credentialId) ? { credentialId: auth.credentialId } : {}) };
  } else {
    const typed = { domain: sponsorDomain(input.chainId), types: SPONSOR_REQUEST_TYPES, primaryType: "SponsorRequest" as const, message: { action: input.action, bodyHash: bodyHash(input.body), issuedAt } };
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({ ...typed, signature: auth.signature });
    } catch {
      throw new AuthError("malformed signature");
    }
    if (auth.kind === "eoa") {
      if (signer !== getAddress(auth.address)) throw new AuthError("bad owner signature");
      identity = { kind: "eoa", id: `eoa:${signer.toLowerCase()}`, address: signer };
    } else if (auth.kind === "session") {
      if (signer !== getAddress(auth.key)) throw new AuthError("bad session signature");
      if ((await input.sessionExpiry(getAddress(auth.account), signer)) < BigInt(now)) throw new AuthError("session key not authorized by account");
      identity = { kind: "session", id: `account:${auth.account.toLowerCase()}`, account: getAddress(auth.account), key: signer };
    } else {
      throw new AuthError("unknown auth kind");
    }
  }
  input.seen.set(auth.signature, now);
  return identity;
}

/** Owner identity from its id string (`eoa:0x…` or `passkey:0x…:0x…`). */
export function parseIdentityId(id: string): Identity | null {
  const eoa = /^eoa:(0x[0-9a-f]{40})$/.exec(id);
  if (eoa) return { kind: "eoa", id, address: getAddress(eoa[1]!) };
  const passkey = /^passkey:(0x[0-9a-f]{64}):(0x[0-9a-f]{64})$/.exec(id);
  if (passkey) return { kind: "passkey", id, x: passkey[1] as Hex, y: passkey[2] as Hex };
  return null;
}
