import { describe, expect, it } from "vitest";
import { contentCid, type Storage } from "fil-folders";
import { createCredential, defaultGroupKeyId, openCredential } from "fil-folders/private";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { identityShareFragment, identityStorage, isIdentityFragment, privateIdentityFetcher } from "../src/private/index.js";
import { resolveIdentity } from "../src/view/resolve.js";

describe("TrePerson private identity link", () => {
  it("one group link keeps opening the identity after it is updated", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const pieces = new Map<string, Uint8Array>();
    const inner: Storage = {
      async put(data) {
        const bytes = data as Uint8Array;
        const pieceCid = await contentCid(bytes);
        pieces.set(pieceCid, bytes);
        return { pieceCid, size: bytes.byteLength };
      },
      async get(cid) {
        return pieces.get(cid)!;
      },
    };
    const session = generatePrivateKey();
    const { credential } = await createCredential({ wallet: owner, sessionPrivateKey: session, chainId: 314159, groupKeyId: defaultGroupKeyId(owner.address), expires: Math.floor(Date.now() / 1000) + 3600 });
    const cred = await openCredential(session, credential);
    const storage = identityStorage(inner, cred);
    const id = (name: string) => new TextEncoder().encode(JSON.stringify({ v: 1, address: owner.address.toLowerCase(), displayName: name }));
    const first = await storage.put(id("Andy"));
    const fragment = await identityShareFragment({ credential: cred, chainId: 314159, network: "calibration", providers: ["https://sp.test"] });
    expect(isIdentityFragment(fragment)).toBe(true);
    expect(fragment).not.toContain(cred.groupKey.toString());

    const requests: string[] = [];
    const curio = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(url));
      if (!new Headers(init?.headers).get("authorization")?.startsWith("FOC-Grant ")) return new Response("", { status: 401 });
      const body = pieces.get(String(url).split("/download/")[1]!);
      return body ? new Response(body as BodyInit) : new Response("", { status: 404 });
    }) as typeof fetch;
    const fetchPiece = privateIdentityFetcher(fragment, { fetchImpl: curio });
    let head = first.pieceCid;
    let version = 1n;
    const opts = { head: async () => ({ pieceCid: new TextEncoder().encode(head), version }), fetchPiece, cache: null };
    expect((await resolveIdentity(owner.address, opts)).displayName).toBe("Andy");
    // The person updates their profile: same link, new piece.
    head = (await storage.put(id("Andy J"))).pieceCid;
    version = 2n;
    expect((await resolveIdentity(owner.address, opts)).displayName).toBe("Andy J");
    expect(requests.every((u) => u.startsWith("https://sp.test/download/"))).toBe(true);
  });
});
