import { describe, expect, it } from "vitest";
import { COWORKERS_CACHE_PREFIX } from "../src/clubs/index.js";
import { details, needsClubScan, personUrl, suggest } from "../src/people/index.js";
import { normalizeIdentity, writeIdentityCache, WALLET_KEY } from "../src/view/index.js";

const me = "0x1111111111111111111111111111111111111111";
const bea = "0x2222222222222222222222222222222222222222";
const carl = "0x3333333333333333333333333333333333333333";
const dan = "0x4444444444444444444444444444444444444444";

function kv() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("people", () => {
  it("suggest ranks club-mates + participants by name; details gives shared clubs and Slack", () => {
    const s = kv();
    s.setItem(WALLET_KEY, me);
    expect(needsClubScan(s)).toBe(true);
    s.setItem(COWORKERS_CACHE_PREFIX + me, JSON.stringify({ address: me, clubs: [{ id: "1", name: "Acme", members: [me, bea, carl], admins: [me], role: "admin" }], coworkers: [bea, carl], checkedAt: 1 }));
    writeIdentityCache(bea, { identity: normalizeIdentity(bea, { displayName: "Bea Arthur", bio: "PM", notify: { contacts: [{ channel: "slack", team: "T0ACME", user: "U0BEA", domain: "acme" }] } }), pieceCid: "x" }, s);
    writeIdentityCache(carl, { identity: normalizeIdentity(carl, { displayName: "Carl Bea" }), pieceCid: "y" }, s);
    expect(needsClubScan(s)).toBe(false);
    expect(suggest("bea", { kv: s }).map((p) => p.name)).toEqual(["Bea Arthur", "Carl Bea"]);
    const all = suggest("", { kv: s, participants: [{ address: dan }] });
    expect(all.map((p) => p.hint)).toContain("In this document");
    expect(all.every((p) => p.iconUrl.startsWith("data:image/"))).toBe(true);
    expect(suggest("zz", { kv: s })).toEqual([]);
    const d = details(bea, s)!;
    expect(d).toMatchObject({ name: "Bea Arthur", bio: "PM", sharedClubs: ["Acme"], contactLabel: "Slack · acme.slack.com", hasIdentity: true });
    expect(personUrl(bea, "https://fifolders.scionbase.ai/fipen/#d")).toBe(`https://fifolders.scionbase.ai/person/?id=${bea}`);
  });
});
