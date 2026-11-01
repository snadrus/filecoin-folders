import { describe, expect, it } from "vitest";
import { openVolume } from "../src/index.js";
import { OWNER, contains, decode, makeVolume, ownerAccount, signerOf, text } from "./helpers.js";

describe("encryption", () => {
  it("round-trips file bytes and names without storing the plaintext", async () => {
    const { volume, storage, registry } = await makeVolume({ encryption: true });
    await volume.put("/secret.txt", text("top secret"), { mime: "text/plain" });
    await volume.mkdir("/文件夹");
    await volume.put("/文件夹/héllo.txt", text("café"));

    expect(decode(await volume.get("/secret.txt"))).toBe("top secret");
    expect(decode(await volume.get("/文件夹/héllo.txt"))).toBe("café");
    expect((await volume.ls("/")).map((entry) => entry.name).sort()).toEqual(["secret.txt", "文件夹"]);
    expect((await volume.history("/secret.txt")).map((entry) => entry.change)).toEqual(["added"]);

    for (const piece of storage.pieces.values()) {
      expect(contains(piece, "top secret")).toBe(false);
      expect(contains(piece, "secret.txt")).toBe(false);
      expect(contains(piece, "héllo.txt")).toBe(false);
      expect(contains(piece, "café")).toBe(false);
    }

    const again = await openVolume({
      storage,
      registry,
      owner: OWNER,
      name: "demo",
      now: () => 1_700_000_000_000,
      encryption: {
        signer: signerOf(ownerAccount),
        chainId: 314159,
        registryAddress: "0x00000000000000000000000000000000000000c0",
      },
    });
    await again.cp("/secret.txt", "/copy.txt");
    expect(decode(await again.get("/copy.txt"))).toBe("top secret");

    await expect(
      openVolume({
        storage,
        registry,
        owner: OWNER,
        name: "demo",
        encryption: {
          signer: signerOf(ownerAccount),
          mode: "personal_sign",
          chainId: 314159,
          registryAddress: "0x00000000000000000000000000000000000000c0",
        },
      }),
    ).rejects.toThrow(/decryption failed/);
  });

  it("round-trips a volume key derived from personal_sign", async () => {
    const { volume } = await makeVolume({ encryption: "personal_sign", name: "personal" });
    await volume.put("/note.txt", text("signed"));
    expect(decode(await volume.get("/note.txt"))).toBe("signed");
    expect((await volume.ls("/"))[0]?.name).toBe("note.txt");
  });
});
