import * as Keysmith from "@filoz/keysmith";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MemoryRegistry, openVolume, type Storage } from "../src/index.js";
import { contentCid } from "../src/car.js";
import {
  createCredential,
  createPrivateStorage,
  datasetVisibility,
  defaultGroupKeyId,
  deriveMemberKey,
  encodeShareFragment,
  isFeeCar,
  isPrivateShareFragment,
  makeFileShare,
  makeGroupShare,
  openCredential,
  openFileShare,
  openPiece,
  openShare,
  parseShareFragment,
  privateDataSetMetadata,
  readLabels,
  sealPiece,
  unpackFeeCar,
  volumeGroup,
  volumeKeyFromGroupKey,
  cidBytes,
} from "../src/private/index.js";
import { OWNER, decode, ownerAccount, text, contains } from "./helpers.js";

const CHAIN_ID = 314159;
const descriptor = { owner: OWNER, groupKeyId: defaultGroupKeyId(OWNER) };

async function groupKey() {
  return (await Keysmith.deriveGroupKey(ownerAccount, descriptor)).groupKey;
}

/** A piece store whose ids are real CIDs, so presentations can bind to them. */
class CidStorage implements Storage {
  readonly pieces = new Map<string, Uint8Array>();
  readonly metadata = new Map<string, Record<string, string>>();
  async put(data: Uint8Array | ReadableStream<Uint8Array>, options?: { metadata?: Record<string, string> }) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(await new Response(data).arrayBuffer());
    const pieceCid = await contentCid(bytes);
    this.pieces.set(pieceCid, bytes);
    if (options?.metadata) this.metadata.set(pieceCid, options.metadata);
    return { pieceCid, size: bytes.byteLength };
  }
  async get(cid: string) {
    const bytes = this.pieces.get(cid);
    if (!bytes) throw new Error(`unknown ${cid}`);
    return bytes;
  }
}

/** A fake Curio `/download/` gate: 401 without a grant, verifies the presentation against the piece labels. */
function fakeCurio(storage: CidStorage) {
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const cid = decodeURIComponent(url.pathname.replace(/^\/download\//, ""));
    const outer = storage.pieces.get(cid);
    if (!outer) return new Response("not found", { status: 404 });
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (!auth.startsWith("FOC-Grant ")) return new Response("", { status: 401, headers: { "WWW-Authenticate": "FOC-Grant" } });
    const piece = await readLabels(outer);
    try {
      const b64 = auth.slice("FOC-Grant ".length);
      const bytes = Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0));
      await Keysmith.verifyPresentation(bytes, { pieceCid: cidBytes(cid), piece, chainId: BigInt(CHAIN_ID) });
    } catch (error) {
      seen.push(`403 ${(error as Error).message}`);
      return new Response("", { status: 403 });
    }
    seen.push(`200 ${cid}`);
    return new Response(outer as BodyInit, { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("private data sets", () => {
  it("classifies data set metadata", () => {
    expect(datasetVisibility({})).toBe("public");
    expect(datasetVisibility({ "foc/enc": "1" })).toBe("encrypted");
    const meta = privateDataSetMetadata({ owner: OWNER, groupKeyId: descriptor.groupKeyId, commitment: "v2." + "ab".repeat(16) });
    expect(meta.read).toBe("restricted");
    expect(datasetVisibility(meta)).toBe("private");
  });

  it("uses the shared default group key id (filecoin-pin / Filecoin Drive)", () => {
    // Same derivation as filecoin-pin's defaultGroupKeyId(owner).
    expect(defaultGroupKeyId(OWNER)).toMatch(/^0x[0-9a-f]{32}$/);
    expect(volumeGroup("My Drive")).toMatch(/^FiFolders\/v[0-9a-f]{16}$/);
    expect(volumeGroup("My Drive")).not.toContain("Drive");
  });

  it("seals a piece as an outer CAR holding encrypted.fee, and opens it", async () => {
    const key = await groupKey();
    const target = Keysmith.writeTarget(Keysmith.grantDescriptor(descriptor, "groupKey"), key, volumeGroup("demo"));
    const plain = text("hello private world ".repeat(1000));
    const sealed = await sealPiece(target, plain);
    expect(isFeeCar(sealed.car)).toBe(true);
    expect(contains(sealed.car, "hello private")).toBe(false);
    const envelope = unpackFeeCar(sealed.car);
    expect([0xd0, 0xd8]).toContain(envelope[0]); // COSE_Encrypt0 (16) or COSE_Encrypt (96) tag
    const opened = await openPiece(sealed.car, key);
    expect(decode(opened.plaintext)).toBe(decode(plain));
    expect(opened.labels.groupKeyId).toBe(descriptor.groupKeyId);
    // A different owner's key does not open it.
    const other = privateKeyToAccount(generatePrivateKey());
    const otherKey = (await Keysmith.deriveGroupKey(other, { owner: other.address, groupKeyId: defaultGroupKeyId(other.address) })).groupKey;
    await expect(openPiece(sealed.car, otherKey)).rejects.toThrow();
  });

  it("packs multi-leaf envelopes", async () => {
    const key = await groupKey();
    const target = Keysmith.writeTarget(Keysmith.grantDescriptor(descriptor, "groupKey"), key);
    const plain = new Uint8Array(2_500_000);
    for (let i = 0; i < plain.length; i++) plain[i] = i % 251;
    const sealed = await sealPiece(target, plain);
    const opened = await openPiece(sealed.car, key);
    expect(opened.plaintext).toEqual(plain);
  });

  it("stores a session credential that reopens without the wallet", async () => {
    const sessionKey = generatePrivateKey();
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const { credential, groupKey: gk } = await createCredential({
      wallet: ownerAccount,
      sessionPrivateKey: sessionKey,
      chainId: CHAIN_ID,
      groupKeyId: descriptor.groupKeyId,
      expires,
    });
    expect(JSON.stringify(credential)).not.toContain(Buffer.from(gk).toString("hex"));
    const opened = await openCredential(sessionKey, credential);
    expect(opened.groupKey).toEqual(gk);
    expect(opened.expired).toBe(false);
    await expect(openCredential(generatePrivateKey(), credential)).rejects.toThrow();
  });

  it("runs a private volume with per-file keys, and shares one file by fragment", async () => {
    const sessionKey = generatePrivateKey();
    const { credential } = await createCredential({
      wallet: ownerAccount,
      sessionPrivateKey: sessionKey,
      chainId: CHAIN_ID,
      groupKeyId: descriptor.groupKeyId,
      expires: Math.floor(Date.now() / 1000) + 3600,
    });
    const cred = await openCredential(sessionKey, credential);
    const inner = new CidStorage();
    const curio = fakeCurio(inner);
    const { fetchGated } = await import("../src/private/gated.js");
    const target = Keysmith.writeTarget(Keysmith.grantDescriptor(descriptor, "groupKey"), cred.groupKey, volumeGroup("demo"));
    const storage = createPrivateStorage(inner, {
      target,
      readKey: cred.groupKey,
      fetchPiece: (cid) => fetchGated({ providers: ["https://sp.example"], cid, signer: cred.bearer, chain: cred.chain, fetchImpl: curio.fetchImpl }),
    });
    const registry = new MemoryRegistry(OWNER);
    const volume = await openVolume({
      storage,
      registry,
      owner: OWNER,
      name: "demo",
      now: () => 1_700_000_000_000,
      encryption: { key: await volumeKeyFromGroupKey(cred.groupKey), perFileKeys: true },
    });
    await volume.put("/notes/secret.txt", text("the eagle lands at noon"), { mime: "text/plain" });
    await volume.put("/other.txt", text("unrelated secret"));
    expect(decode(await volume.get("/notes/secret.txt"))).toBe("the eagle lands at noon");

    for (const [cid, piece] of inner.pieces) {
      expect(isFeeCar(piece)).toBe(true);
      expect(contains(piece, "eagle")).toBe(false);
      expect(contains(piece, "secret.txt")).toBe(false);
      expect(inner.metadata.get(cid)?.label).toBe("encrypted.fee");
    }

    // Reopen from a fresh volume (gated reads only).
    const again = await openVolume({
      storage: createPrivateStorage(inner, {
        target,
        readKey: cred.groupKey,
        fetchPiece: (cid) => fetchGated({ providers: ["https://sp.example"], cid, signer: cred.bearer, chain: cred.chain, fetchImpl: curio.fetchImpl }),
      }),
      registry,
      owner: OWNER,
      name: "demo",
      encryption: { key: await volumeKeyFromGroupKey(cred.groupKey), perFileKeys: true },
    });
    expect((await again.ls("/")).map((e) => e.name).sort()).toEqual(["notes", "other.txt"]);

    // Share one file: delegated from the session credential (no wallet prompt).
    const info = await volume.fileShareInfo("/notes/secret.txt");
    const outer = inner.pieces.get(info.piece)!;
    const share = await makeFileShare({
      issuer: { kind: "delegate", signer: cred.bearer, chain: cred.chain, parentKey: cred.groupKey },
      ref: descriptor,
      chainId: CHAIN_ID,
      network: "calibration",
      providers: ["https://sp.example"],
      piece: info.piece,
      labels: await readLabels(outer),
      file: { cid: info.contentCid, iv: info.iv, key: info.fileKey, name: "secret.txt", size: info.size, mime: "text/plain" },
    });
    const fragment = encodeShareFragment(share);
    const url = `https://fifolders.example/share/#${fragment}`;
    expect(new URL(url).search).toBe("");
    expect(isPrivateShareFragment(`#${fragment}`)).toBe(true);
    const parsed = parseShareFragment(`#${fragment}`);
    expect(parsed?.kind).toBe("file");
    const bytes = await openFileShare(parsed as never, { fetchImpl: curio.fetchImpl });
    expect(decode(bytes)).toBe("the eagle lands at noon");

    // The link's piece key does not open other pieces, and its file key does not open other files.
    const otherInfo = await volume.fileShareInfo("/other.txt");
    const opened = await openShare(parsed!);
    if (otherInfo.piece !== info.piece) {
      await expect(openPiece(inner.pieces.get(otherInfo.piece)!, opened.key, opened.grant)).rejects.toThrow();
    }
    await expect(openFileShare({ ...(parsed as never as object), cid: otherInfo.contentCid, iv: otherInfo.iv } as never, { fetchImpl: curio.fetchImpl })).rejects.toThrow();
    expect(curio.seen.some((s) => s.startsWith("403"))).toBe(false);
  });

  it("group share links open every piece of a group, including later ones", async () => {
    const key = await groupKey();
    const inner = new CidStorage();
    const curio = fakeCurio(inner);
    const target = Keysmith.writeTarget(Keysmith.grantDescriptor(descriptor, "groupKey"), key, "FiPerson/identity");
    const v1 = await sealPiece(target, text("profile v1"));
    await inner.put(v1.car);
    const share = await makeGroupShare({
      issuer: { kind: "owner", wallet: ownerAccount, groupKey: key },
      ref: descriptor,
      chainId: CHAIN_ID,
      network: "calibration",
      providers: ["https://sp.example"],
      group: "FiPerson/identity",
    });
    const v2 = await sealPiece(target, text("profile v2"));
    const { pieceCid } = await inner.put(v2.car);
    const parsed = parseShareFragment(encodeShareFragment(share))!;
    const opened = await openShare(parsed);
    const { fetchSharedPiece } = await import("../src/private/share.js");
    // fetchSharedPiece unpads; profile pieces here are not padded, so open the raw envelope.
    const { fetchGated } = await import("../src/private/gated.js");
    const outer = await fetchGated({ providers: parsed.providers, cid: pieceCid, signer: opened.bearer, chain: opened.chain, fetchImpl: curio.fetchImpl });
    expect(decode((await openPiece(outer, opened.key, opened.grant)).plaintext)).toBe("profile v2");
    expect(typeof fetchSharedPiece).toBe("function");
    // A different group is out of reach.
    const elsewhere = await sealPiece(Keysmith.writeTarget(Keysmith.grantDescriptor(descriptor, "groupKey"), key, "FiFolders/vdeadbeef"), text("not yours"));
    await expect(openPiece(elsewhere.car, opened.key, opened.grant)).rejects.toThrow();
  });

  it("derives a stable member key from a deterministic signature", async () => {
    const a = await deriveMemberKey(ownerAccount, CHAIN_ID);
    const b = await deriveMemberKey(ownerAccount, CHAIN_ID, { verify: false });
    expect(a).toEqual(b);
    expect(a.address).not.toBe(OWNER);
    const flaky = { address: OWNER, signTypedData: async () => generatePrivateKey() + "00" as `0x${string}` };
    await expect(deriveMemberKey(flaky, CHAIN_ID)).rejects.toThrow(/deterministic/);
  });
});
