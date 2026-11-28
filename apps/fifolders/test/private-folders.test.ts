import { describe, expect, it } from "vitest";
import { MemoryRegistry, openVolume, type Storage } from "fil-folders";
import { Keysmith, createCredential, createPrivateStorage, defaultGroupKeyId, openCredential, readLabels, volumeGroup, volumeKeyFromGroupKey } from "fil-folders/private";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { visibilityBadge, visibilityOf } from "../src/private/visibility.js";
import { makeVolumeFileShare } from "../src/private/share-link.js";
import { mountPrivateShare } from "../src/private/share-page.js";

const owner = privateKeyToAccount(generatePrivateKey());

async function cidOf(bytes: Uint8Array): Promise<string> {
  const { contentCid } = await import("fil-folders");
  return (contentCid as (b: Uint8Array) => Promise<string>)(bytes);
}

describe("private folders (app)", () => {
  it("shows Public/Private from data set metadata", () => {
    expect(visibilityOf({ read: "restricted" })).toBe("private");
    expect(visibilityOf({ "foc/enc": "1" })).toBe("encrypted");
    expect(visibilityBadge("private")).toContain('data-visibility="private"');
    expect(visibilityBadge("encrypted")).toContain('data-visibility="public"');
    expect(visibilityBadge(undefined)).toBe("");
  });

  it("makes a fragment-only link for a file and the guest page decrypts it", async () => {
    const pieces = new Map<string, Uint8Array>();
    const inner: Storage = {
      async put(data) {
        const bytes = data as Uint8Array;
        const pieceCid = await cidOf(bytes);
        pieces.set(pieceCid, bytes);
        return { pieceCid, size: bytes.byteLength };
      },
      async get(cid) {
        return pieces.get(cid)!;
      },
    };
    const sessionKey = generatePrivateKey();
    const groupKeyId = defaultGroupKeyId(owner.address);
    const { credential } = await createCredential({ wallet: owner, sessionPrivateKey: sessionKey, chainId: 314159, groupKeyId, expires: Math.floor(Date.now() / 1000) + 3600 });
    const cred = await openCredential(sessionKey, credential);
    const storage = createPrivateStorage(inner, {
      target: Keysmith.writeTarget(Keysmith.grantDescriptor(cred.ref, "groupKey"), cred.groupKey, volumeGroup("v")),
      readKey: cred.groupKey,
    });
    const volume = await openVolume({ storage, registry: new MemoryRegistry(owner.address), owner: owner.address, name: "v", encryption: { key: await volumeKeyFromGroupKey(cred.groupKey), perFileKeys: true } });
    await volume.put("/hello.txt", new TextEncoder().encode("hi guest"), { mime: "text/plain" });
    const link = await makeVolumeFileShare({ volume, credential: cred, labels: storage.labels, storage, providers: ["https://sp.example"], chain: "calibration", chainId: 314159, path: "/hello.txt", base: "https://app.example/" });
    const url = new URL(link);
    expect(url.pathname).toBe("/share/");
    expect(url.search).toBe("");
    const doc = await makeVolumeFileShare({ volume, credential: cred, labels: storage.labels, storage, providers: ["https://sp.example"], chain: "calibration", chainId: 314159, path: "/hello.txt", base: "https://app.example/" });
    expect(doc).toContain("#v=pf1");

    const fakeCurio = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const cid = String(input).split("/download/")[1]!;
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (!auth.startsWith("FOC-Grant ")) return new Response("", { status: 401 });
      const outer = pieces.get(cid);
      expect(outer).toBeTruthy();
      await readLabels(outer!);
      return new Response(outer as BodyInit);
    }) as typeof fetch;
    const root = document.createElement("main");
    await mountPrivateShare(root, url.hash, fakeCurio);
    expect(root.querySelector("[data-testid=share-preview]")?.textContent).toBe("hi guest");
    expect(root.querySelector("[data-testid=share-download]")?.getAttribute("download")).toBe("hello.txt");
  });

  it("links TrePen documents to the editor with the key in the fragment", async () => {
    const pieces = new Map<string, Uint8Array>();
    const inner: Storage = {
      async put(data) {
        const bytes = data as Uint8Array;
        const pieceCid = await cidOf(bytes);
        pieces.set(pieceCid, bytes);
        return { pieceCid, size: bytes.byteLength };
      },
      async get(cid) {
        return pieces.get(cid)!;
      },
    };
    const sessionKey = generatePrivateKey();
    const { credential } = await createCredential({ wallet: owner, sessionPrivateKey: sessionKey, chainId: 314159, groupKeyId: defaultGroupKeyId(owner.address), expires: Math.floor(Date.now() / 1000) + 3600 });
    const cred = await openCredential(sessionKey, credential);
    const storage = createPrivateStorage(inner, { target: Keysmith.writeTarget(Keysmith.grantDescriptor(cred.ref, "groupKey"), cred.groupKey, volumeGroup("v")), readKey: cred.groupKey });
    const volume = await openVolume({ storage, registry: new MemoryRegistry(owner.address), owner: owner.address, name: "v", encryption: { key: await volumeKeyFromGroupKey(cred.groupKey), perFileKeys: true } });
    await volume.put("/notes.fipen", new TextEncoder().encode("{}"));
    const link = new URL(await makeVolumeFileShare({ volume, credential: cred, labels: storage.labels, storage, providers: ["https://sp.example"], chain: "calibration", chainId: 314159, path: "/notes.fipen", base: "https://app.example/" }));
    expect(link.pathname).toBe("/fipen/");
    expect(link.hash.startsWith("#fp=")).toBe(true);
    expect(decodeURIComponent(link.hash.slice(4))).toContain("v=pf1");
  });
});
