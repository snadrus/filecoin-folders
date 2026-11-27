import { describe, expect, it } from "vitest";
import {
  canUseDirectPasskeys,
  directPasskeyHost,
  findExistingPasskey,
  passkeyRpId,
  PASSKEY_RP_ID,
  type PasskeyHost,
  type PasskeyPublicKey,
} from "../src/passkey.js";

describe("passkeyRpId", () => {
  it("uses the stable scionbase.ai id on production hosts", () => {
    expect(passkeyRpId("scionbase.ai")).toBe(PASSKEY_RP_ID);
    expect(passkeyRpId("fifolders.scionbase.ai")).toBe(PASSKEY_RP_ID);
    expect(passkeyRpId("wallet.scionbase.ai")).toBe(PASSKEY_RP_ID);
    expect(canUseDirectPasskeys("fifolders.scionbase.ai")).toBe(true);
  });

  it("does not treat look-alike hosts or localhost as the RP", () => {
    expect(passkeyRpId("localhost")).toBeUndefined();
    expect(passkeyRpId("127.0.0.1")).toBeUndefined();
    expect(passkeyRpId("example.com")).toBeUndefined();
    expect(passkeyRpId("notscionbase.ai")).toBeUndefined();
    expect(passkeyRpId("evilscionbase.ai")).toBeUndefined();
    expect(passkeyRpId("scionbase.ai.evil.com")).toBeUndefined();
    expect(canUseDirectPasskeys("localhost")).toBe(false);
  });
});

describe("findExistingPasskey", () => {
  const key: PasskeyPublicKey = {
    credentialId: "cred-1",
    x: `0x${"11".repeat(32)}`,
    y: `0x${"22".repeat(32)}`,
  };

  function host(ids: string[] = ["cred-1"]): PasskeyHost {
    let i = 0;
    return {
      create: async () => key,
      assert: async () => {
        throw new Error("unused");
      },
      discover: async () => {
        const credentialId = ids[Math.min(i, ids.length - 1)]!;
        i += 1;
        return { credentialId, message: new Uint8Array(32), r: 1n, s: 1n };
      },
    };
  }

  it("uses the default direct host when none is passed", () => {
    expect(directPasskeyHost.create).toBeTypeOf("function");
  });

  it("returns the sponsor record for a known credential", async () => {
    const found = await findExistingPasskey(
      {
        byCredential: async (id) => (id === "cred-1" ? { x: key.x, y: key.y } : null),
        hasAccount: async () => false,
      },
      host(),
    );
    expect(found).toEqual(key);
  });

  it("takes a second discoverable assertion when the credential is unknown", async () => {
    let discovers = 0;
    const inner = host(["cred-1", "cred-1"]);
    const wrapped: PasskeyHost = {
      ...inner,
      discover: async (challenge, id) => {
        discovers += 1;
        return inner.discover(challenge, id);
      },
    };
    await expect(
      findExistingPasskey(
        {
          byCredential: async () => null,
          hasAccount: async () => false,
        },
        wrapped,
      ),
    ).rejects.toThrow(/Could not read this passkey/);
    expect(discovers).toBe(2);
  });
});
