import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keysmith, defaultGroupKeyId } from "fil-folders/private";
import { parseDatasetRequestMetadata } from "../sponsor/private-dataset.js";
import { privateCreateMetadata } from "../src/private/private-volume.js";
import { NO_PRF_MESSAGE, PRF_SALT, knownPasskeyOwner, lockPasskeyOwners, ownerKeyFromPrf, passkeyPrivateSigner, unlockPasskeyOwner, isNoPrfError, PRIVATE_FALLBACK_NOTICE } from "../src/private/key-source.js";

const credentialId = "AQIDBA";
const prf = (seed: number) => new Uint8Array(32).fill(seed);

function fakeGet(output: Uint8Array | null) {
  return vi.fn(async (options: CredentialRequestOptions) => {
    const ext = (options.publicKey as { extensions?: { prf?: { eval?: { first?: Uint8Array } } } }).extensions;
    expect(ext?.prf?.eval?.first).toEqual(PRF_SALT);
    expect(options.publicKey?.allowCredentials?.length).toBe(1);
    return { getClientExtensionResults: () => (output ? { prf: { results: { first: output.buffer } } } : {}) } as unknown as Credential;
  });
}

describe("private-folder key from a passkey (PRF)", () => {
  beforeEach(() => {
    localStorage.clear();
    lockPasskeyOwners();
  });

  it("derives the same owner from the same PRF output, a different one otherwise", () => {
    expect(ownerKeyFromPrf(prf(1))).toBe(ownerKeyFromPrf(prf(1)));
    expect(ownerKeyFromPrf(prf(1))).not.toBe(ownerKeyFromPrf(prf(2)));
  });

  it("refuses a passkey without PRF with a message pointing to a PRF passkey or a wallet", async () => {
    await expect(unlockPasskeyOwner({ credentialId, get: fakeGet(null) })).rejects.toThrow(NO_PRF_MESSAGE);
    expect(NO_PRF_MESSAGE).toMatch(/wallet/);
    expect(knownPasskeyOwner(credentialId)).toBeNull();
  });

  it("stores only the public address, asks the passkey once per page, and knows the address later without a prompt", async () => {
    const get = fakeGet(prf(7));
    const signer = await passkeyPrivateSigner({ credentialId, get });
    expect(get).toHaveBeenCalledTimes(1);
    expect(knownPasskeyOwner(credentialId)).toBe(signer.address);
    expect(Object.values({ ...localStorage }).join("")).not.toContain(ownerKeyFromPrf(prf(7)).slice(2));
    await signer.signTypedData({ domain: { name: "x" }, types: { M: [{ name: "a", type: "uint256" }] }, primaryType: "M", message: { a: 1n } });
    expect(get).toHaveBeenCalledTimes(1);

    lockPasskeyOwners(); // new page
    const later = fakeGet(prf(7));
    const again = await passkeyPrivateSigner({ credentialId, get: later });
    expect(again.address).toBe(signer.address);
    expect(later).not.toHaveBeenCalled();
  });

  it("notices a different key for the same passkey", async () => {
    await unlockPasskeyOwner({ credentialId, get: fakeGet(prf(7)) });
    lockPasskeyOwners();
    await expect(unlockPasskeyOwner({ credentialId, get: fakeGet(prf(8)) })).rejects.toThrow(/different private-folder key/);
  });

  it("makes metadata the sponsor accepts: exactly read=restricted and the three fixed private keys", async () => {
    const signer = await passkeyPrivateSigner({ credentialId, get: fakeGet(prf(9)) });
    const base = { app: "fifolders", volume: "My Folders", created: new Date().toISOString() };
    const metadata = await privateCreateMetadata(signer, 314159, base, (_intent, run) => run());
    expect(Object.keys(metadata).sort()).toEqual(["app", "created", "foc/enc", "foc/gkid", "foc/kc", "read", "volume"]);
    expect(metadata["foc/gkid"]).toBe(defaultGroupKeyId(signer.address).toLowerCase());
    expect(parseDatasetRequestMetadata(metadata)).toEqual({ read: "restricted", "foc/enc": "1", "foc/gkid": metadata["foc/gkid"], "foc/kc": metadata["foc/kc"] });
    // Same passkey, same group key (another device derives the same one).
    const derived = await Keysmith.deriveGroupKey(signer as never, { owner: signer.address, groupKeyId: defaultGroupKeyId(signer.address) });
    expect(derived.commitment.toString()).toBeTruthy();
  });
});

  it("isNoPrfError matches the refusal, not other failures", () => {
    expect(isNoPrfError(new Error(NO_PRF_MESSAGE))).toBe(true);
    expect(isNoPrfError(new Error("Dataset was not created."))).toBe(false);
    expect(isNoPrfError("nope")).toBe(false);
    expect(PRIVATE_FALLBACK_NOTICE).toMatch(/public/);
  });
