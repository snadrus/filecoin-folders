/**
 * Who signs Keysmith (the private-folder owner, `foc/own`) when the storage account is a sponsored smart account.
 *
 * - Wallet sign-in: the wallet itself (same key as filecoin-pin and Filecoin Drive; works on any device with it).
 * - Passkey sign-in: a secp256k1 key derived from the passkey's WebAuthn PRF output. The PRF output never leaves this
 *   tab; the key lives only in memory for the page's lifetime. Only its public address is stored, so later visits
 *   know whose credential to look for before asking for the passkey again. Synced passkeys (iCloud Keychain, Google
 *   Password Manager) give the same key on every device; a passkey without PRF cannot make private folders.
 */
import { concat, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { WalletSigner } from "./private-volume.js";

const LABEL = "trefolders/private-owner/v1";
/** PRF input ("salt"). Fixed: changing it changes every passkey user's private-folder key. */
export const PRF_SALT = new TextEncoder().encode(LABEL);

export const PASSKEY_UNLOCK_INTENT = { title: "Unlock private folders", purpose: "your passkey makes your private-folder key (it stays in this tab)", cost: "free (passkey only)" } as const;

export const NO_PRF_MESSAGE =
  "This passkey can't make an encryption key, so it can't create or open private folders. Use a passkey saved in iCloud Keychain, Google Password Manager or another PRF-capable passkey, or sign in with a wallet.";

export function isNoPrfError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("can't make an encryption key");
}

/** One-line notice when first-run create falls back to a public data set. */
export const PRIVATE_FALLBACK_NOTICE = "This passkey can't encrypt private folders, so this dataset is public.";

/** The owner key for a PRF output. Deterministic: the same passkey gives the same key on every device. */
export function ownerKeyFromPrf(prf: Uint8Array): Hex {
  if (prf.length < 32) throw new Error(NO_PRF_MESSAGE);
  return keccak256(concat([toHex(LABEL), toHex(prf)]));
}

const ownerKey = (credentialId: string) => `trefolders:private-owner:${credentialId}`;

/** The stored public owner address for a passkey (no prompt), if this browser has derived it before. */
export function knownPasskeyOwner(credentialId: string): Address | null {
  try {
    const value = localStorage.getItem(ownerKey(credentialId));
    return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as Address) : null;
  } catch {
    return null;
  }
}

type GetCredential = (options: CredentialRequestOptions) => Promise<Credential | null>;

const unlocked = new Map<string, ReturnType<typeof privateKeyToAccount>>();

/** Ask the passkey for its PRF output and derive the owner account (cached in memory for this page). */
export async function unlockPasskeyOwner(input: { credentialId: string; rpId?: string; get?: GetCredential }): Promise<ReturnType<typeof privateKeyToAccount>> {
  const cached = unlocked.get(input.credentialId);
  if (cached) return cached;
  const get: GetCredential = input.get ?? ((options) => navigator.credentials.get(options));
  const credential = (await get({
    publicKey: {
      ...(input.rpId ? { rpId: input.rpId } : {}),
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: fromB64url(input.credentialId) }],
      userVerification: "required",
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const results = credential?.getClientExtensionResults?.() as { prf?: { results?: { first?: BufferSource } } } | undefined;
  const first = results?.prf?.results?.first;
  if (!first) throw new Error(NO_PRF_MESSAGE);
  const bytes = first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array((first as ArrayBufferView).buffer, (first as ArrayBufferView).byteOffset, (first as ArrayBufferView).byteLength);
  const account = privateKeyToAccount(ownerKeyFromPrf(bytes));
  const known = knownPasskeyOwner(input.credentialId);
  if (known && known.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error("This passkey gave a different private-folder key than before. Use the same passkey you created your private folders with.");
  }
  localStorage.setItem(ownerKey(input.credentialId), account.address);
  unlocked.set(input.credentialId, account);
  return account;
}

/**
 * A Keysmith signer for a passkey. `address` is known without a prompt when this browser derived it before; the
 * passkey is only asked (once per page) when something must actually be signed.
 */
export async function passkeyPrivateSigner(input: { credentialId: string; rpId?: string; get?: GetCredential; prompt?: <T>(run: () => Promise<T>) => Promise<T> }): Promise<WalletSigner> {
  const prompt = input.prompt ?? ((run) => run());
  const unlock = () => prompt(() => unlockPasskeyOwner(input));
  const address = knownPasskeyOwner(input.credentialId) ?? (await unlock()).address;
  return {
    address,
    signTypedData: async (args) => (await unlock()).signTypedData(args),
  };
}

/** Forget the in-memory key (sign-out). */
export function lockPasskeyOwners(): void {
  unlocked.clear();
}

function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
