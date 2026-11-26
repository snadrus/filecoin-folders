/**
 * Passkey (WebAuthn P-256) owner for a LockedSignerAccount: no wallet app, no network or token setup. The passkey
 * signs rarely (account creation, Execute(addSessionKey), sponsor requests); day-to-day signing is the browser
 * secp256k1 session key, because FWSS session keys must be secp256k1.
 *
 * Filecoin has no RIP-7212 P-256 precompile, so the account verifies with OpenZeppelin's Solidity P256 (sponsor pays
 * the gas; it is a handful of calls per user).
 */
import { bytesToHex, encodeAbiParameters, hexToBytes, type Hex } from "viem";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

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

/** Register a passkey for FiFolders on this site. */
export async function createPasskey(name: string): Promise<PasskeyPublicKey> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "FiFolders" },
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
    publicKey: { challenge: new Uint8Array(hexToBytes(challenge)), allowCredentials: [{ type: "public-key", id: fromB64url(credentialId) }], userVerification: "required" },
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
