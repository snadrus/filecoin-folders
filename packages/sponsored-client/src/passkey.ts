/**
 * Passkey (WebAuthn P-256) owner for a LockedSignerAccount: no wallet app, no network or token setup. The passkey
 * signs rarely (account creation, Execute(addSessionKey), sponsor requests); day-to-day signing is the browser
 * secp256k1 session key, because FWSS session keys must be secp256k1.
 *
 * Filecoin has no RIP-7212 P-256 precompile, so the account verifies with OpenZeppelin's Solidity P256 (sponsor pays
 * the gas; it is a handful of calls per user).
 *
 * On scionbase.ai hosts the RP ID is {@link PASSKEY_RP_ID}, so the same discoverable passkey works on every subdomain
 * (including a dedicated wallet host). Other origins cannot create or assert that passkey in-page; they use
 * `connectLimitedWallet` to run the ceremony in a wallet iframe or popup.
 */
import { p256 } from "@noble/curves/p256";
import { bytesToHex, encodeAbiParameters, hexToBytes, type Hex } from "viem";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** Stable WebAuthn RP ID. Any scionbase.ai host (fifolders, wallet, …) can use the same passkeys. */
export const PASSKEY_RP_ID = "scionbase.ai";
export const PASSKEY_RP_NAME = "FiFolders";

/**
 * RP ID for a WebAuthn call in this document. Production hosts under scionbase.ai use {@link PASSKEY_RP_ID}.
 * Localhost and other dev hosts omit it (the browser binds the passkey to the exact hostname); scionbase.ai
 * is not a valid RP ID there and would throw a SecurityError.
 */
export function passkeyRpId(hostname = globalThis.location?.hostname): string | undefined {
  if (!hostname) return undefined;
  if (hostname === PASSKEY_RP_ID || hostname.endsWith(`.${PASSKEY_RP_ID}`)) return PASSKEY_RP_ID;
  return undefined;
}

function rpEntity(): PublicKeyCredentialRpEntity {
  const id = passkeyRpId();
  return id ? { id, name: PASSKEY_RP_NAME } : { name: PASSKEY_RP_NAME };
}

function rpIdField(): { rpId: string } | Record<string, never> {
  const id = passkeyRpId();
  return id ? { rpId: id } : {};
}

/** True when this page can run WebAuthn itself with the production RP ID (a scionbase.ai host). */
export function canUseDirectPasskeys(hostname = globalThis.location?.hostname): boolean {
  return passkeyRpId(hostname) === PASSKEY_RP_ID;
}

/** Ceremony surface used by first-party pages and by the cross-origin limited-wallet connector. */
export interface PasskeyHost {
  create(name: string): Promise<PasskeyPublicKey>;
  assert(credentialId: string, challenge: Hex): Promise<PasskeyAssertion>;
  discover(challenge: Uint8Array, credentialId?: string): Promise<DiscoverableAssertion>;
}

export interface PasskeyPublicKey {
  credentialId: string;
  x: Hex;
  y: Hex;
}

export interface PasskeyAssertion {
  authenticatorData: Hex;
  clientDataJSON: string;
  /** r || s, low-s. */
  signature: Hex;
}

/** Raw discoverable-assertion material (for public-key recovery and credential lookup). */
export interface DiscoverableAssertion {
  credentialId: string;
  message: Uint8Array;
  r: bigint;
  s: bigint;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** DER ECDSA signature → 32-byte r, s with s normalized to the lower half (OZ P256 rejects high s). */
export function derToRS(der: Uint8Array): { r: Hex; s: Hex } {
  if (der[0] !== 0x30) throw new Error("not a DER signature");
  let offset = 2;
  const read = () => {
    if (der[offset] !== 0x02) throw new Error("bad DER integer");
    const length = der[offset + 1]!;
    const value = der.slice(offset + 2, offset + 2 + length);
    offset += 2 + length;
    return BigInt(bytesToHex(value));
  };
  const r = read();
  let s = read();
  if (s > N / 2n) s = N - s;
  const pad = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}` as Hex;
  return { r: pad(r), s: pad(s) };
}

/** P-256 point from a SubjectPublicKeyInfo (AuthenticatorAttestationResponse.getPublicKey()). */
export function spkiToXY(spki: Uint8Array): { x: Hex; y: Hex } {
  const point = spki.slice(spki.length - 65);
  if (point[0] !== 0x04) throw new Error("expected an uncompressed P-256 key");
  return { x: bytesToHex(point.slice(1, 33)), y: bytesToHex(point.slice(33, 65)) };
}

/** ABI-encode an assertion for LockedSignerAccount.execute (LockedWebAuthn.Assertion). */
export function encodeContractAssertion(assertion: PasskeyAssertion): Hex {
  const json = assertion.clientDataJSON;
  const typeIndex = json.indexOf('"type":"webauthn.get"');
  const challengeIndex = json.indexOf('"challenge":"');
  if (typeIndex < 0 || challengeIndex < 0) throw new Error("unexpected clientDataJSON");
  const signature = hexToBytes(assertion.signature);
  return encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "string" }, { name: "challengeIndex", type: "uint256" }, { name: "typeIndex", type: "uint256" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] }],
    [{ authenticatorData: assertion.authenticatorData, clientDataJSON: json, challengeIndex: BigInt(challengeIndex), typeIndex: BigInt(typeIndex), r: bytesToHex(signature.slice(0, 32)), s: bytesToHex(signature.slice(32, 64)) }],
  );
}

/** Register a passkey for FiFolders (discoverable, so another device can pick it later). Bound to {@link PASSKEY_RP_ID} on scionbase.ai hosts. */
export async function createPasskey(name: string): Promise<PasskeyPublicKey> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: rpEntity(),
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name, displayName: name },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey creation was cancelled.");
  const response = credential.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey?.();
  if (!spki) throw new Error("This browser cannot export the passkey public key.");
  return { credentialId: b64url(new Uint8Array(credential.rawId)), ...spkiToXY(new Uint8Array(spki)) };
}

/** Sign a 32-byte challenge (an EIP-712 digest) with the passkey. */
export async function passkeyAssert(credentialId: string, challenge: Hex): Promise<PasskeyAssertion> {
  const credential = (await navigator.credentials.get({
    publicKey: { ...rpIdField(), challenge: new Uint8Array(hexToBytes(challenge)), allowCredentials: [{ type: "public-key", id: fromB64url(credentialId) }], userVerification: "required" },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey signature was cancelled.");
  const response = credential.response as AuthenticatorAssertionResponse;
  const { r, s } = derToRS(new Uint8Array(response.signature));
  return {
    authenticatorData: bytesToHex(new Uint8Array(response.authenticatorData)),
    clientDataJSON: new TextDecoder().decode(response.clientDataJSON),
    signature: `${r}${s.slice(2)}` as Hex,
  };
}

/** Raw discoverable assertion: the browser lists every FiFolders passkey (synced or on a security key). */
export async function discoverablePasskeyAssert(challenge: Uint8Array, credentialId?: string): Promise<DiscoverableAssertion> {
  const challengeBytes = new Uint8Array(challenge);
  const credential = (await navigator.credentials.get({
    publicKey: { ...rpIdField(), challenge: challengeBytes, userVerification: "required", ...(credentialId ? { allowCredentials: [{ type: "public-key" as const, id: fromB64url(credentialId) }] } : {}) },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was picked.");
  const response = credential.response as AuthenticatorAssertionResponse;
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", response.clientDataJSON));
  const authData = new Uint8Array(response.authenticatorData);
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData);
  signed.set(clientHash, authData.length);
  const message = new Uint8Array(await crypto.subtle.digest("SHA-256", signed));
  const { r, s } = derToRS(new Uint8Array(response.signature));
  return { credentialId: b64url(new Uint8Array(credential.rawId)), message, r: BigInt(r), s: BigInt(s) };
}

/** Public keys that could have produced this P-256 signature (ECDSA recovery; WebAuthn does not return the key). */
export function recoverPasskeyCandidates(message: Uint8Array, r: bigint, s: bigint): { x: Hex; y: Hex }[] {
  const out: { x: Hex; y: Hex }[] = [];
  for (const bit of [0, 1]) {
    try {
      const point = new p256.Signature(r, s).addRecoveryBit(bit).recoverPublicKey(message);
      const { x, y } = point.toAffine();
      out.push({ x: `0x${x.toString(16).padStart(64, "0")}`, y: `0x${y.toString(16).padStart(64, "0")}` });
    } catch {
      /* no point for this recovery bit */
    }
  }
  return out;
}

export const directPasskeyHost: PasskeyHost = {
  create: createPasskey,
  assert: passkeyAssert,
  discover: discoverablePasskeyAssert,
};

/**
 * Returning user on any device: pick an existing FiFolders passkey and get its public key back.
 * 1) the sponsor knows the credential (it is recorded at the first purchase), else
 * 2) ECDSA-recover the two candidate keys and ask the sponsor which one owns an account, else
 * 3) a second signature pins the key down (a passkey that never bought credits has no account yet).
 *
 * Pass `passkeys` to run the ceremonies in a cross-origin wallet frame (see `connectLimitedWallet`).
 */
export async function findExistingPasskey(
  lookup: {
    byCredential(credentialId: string): Promise<{ x: Hex; y: Hex } | null>;
    hasAccount(key: { x: Hex; y: Hex }): Promise<boolean>;
  },
  passkeys: PasskeyHost = directPasskeyHost,
): Promise<PasskeyPublicKey> {
  const first = await passkeys.discover(crypto.getRandomValues(new Uint8Array(32)));
  const known = await lookup.byCredential(first.credentialId).catch(() => null);
  if (known) return { credentialId: first.credentialId, x: known.x, y: known.y };
  const candidates = recoverPasskeyCandidates(first.message, first.r, first.s);
  for (const key of candidates) if (await lookup.hasAccount(key).catch(() => false)) return { credentialId: first.credentialId, ...key };
  const second = await passkeys.discover(crypto.getRandomValues(new Uint8Array(32)), first.credentialId);
  const again = recoverPasskeyCandidates(second.message, second.r, second.s);
  const match = candidates.find((key) => again.some((other) => other.x === key.x && other.y === key.y));
  if (!match) throw new Error("Could not read this passkey's public key. Try again, or create a new passkey.");
  return { credentialId: first.credentialId, ...match };
}
