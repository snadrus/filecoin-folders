import { describe, expect, it } from "vitest";
import { checkBlob, encodeBlob, parseBlob, typedDataJson, type RemovalBlob } from "../src/ficlub/core.js";

const A = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const B = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const C = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";
const K = "0x1111111111111111111111111111111111111111";
const blob: RemovalBlob = { kind: "ficlub/remove-admin", v: 1, chainId: 314159, contract: K, clubId: "1", clubName: "x", target: C, nonce: "0", deadline: "2000", signer1: A, sig1: ("0x" + "ab".repeat(65)) as `0x${string}` };
const club = { id: 1n, name: "x", creator: A, nonce: 0n, members: [A], admins: [A, B, C] } as const;
const ctx = { chainId: 314159, contract: K, club: { ...club, admins: [...club.admins], members: [...club.members] }, me: B, now: 1000 } as never;

describe("ficlub blob", () => {
  it("round-trips and validates", () => {
    expect(parseBlob(encodeBlob(blob))).toEqual(blob);
    expect(checkBlob(blob, ctx)).toEqual([]);
  });
  it("target may co-sign", () => expect(checkBlob(blob, { ...(ctx as object), me: C } as never)).toEqual([]));
  it("rejects junk / bad sig", () => {
    expect(() => parseBlob("nope")).toThrow();
    expect(() => parseBlob(encodeBlob({ ...blob, sig1: "0x12" as never }))).toThrow(/65 bytes/);
  });
  it("flags expired, replayed, same signer, wrong contract, too few admins", () => {
    const c = ctx as { club: { nonce: bigint; admins: string[] } };
    expect(checkBlob(blob, { ...(ctx as object), now: 3000 } as never).join()).toMatch(/Expired/);
    expect(checkBlob(blob, { ...(ctx as object), club: { ...c.club, nonce: 1n } } as never).join()).toMatch(/nonce/);
    expect(checkBlob(blob, { ...(ctx as object), me: A } as never).join()).toMatch(/different admin/);
    expect(checkBlob({ ...blob, contract: B }, ctx).join()).toMatch(/different network/);
    expect(checkBlob(blob, { ...(ctx as object), club: { ...c.club, admins: [A, C] } } as never).join()).toMatch(/2 or fewer/);
  });
  it("typed data is v4 JSON", () => {
    const t = JSON.parse(typedDataJson(314159, K, { clubId: 1n, target: C, nonce: 0n, deadline: 5n }));
    expect(t.primaryType).toBe("RemoveAdmin");
    expect(t.domain).toMatchObject({ name: "FiClub", version: "1", chainId: 314159 });
  });
});
