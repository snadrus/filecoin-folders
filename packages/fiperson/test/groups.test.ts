import { decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { FICLUB_VAULT_ABI, encodeGrant, findMyGroups, memberKeyOf, personFromLink, withMemberKey } from "../src/groups/index.js";
import { parseIdentity } from "../src/view/schema.js";

const ME = "0x00000000000000000000000000000000000000a1";
const ADMIN = "0x00000000000000000000000000000000000000b2";
const KEY = "0x00000000000000000000000000000000000000c3";

describe("fiperson/groups", () => {
  it("publishes and reads a member key through the identity doc", () => {
    const doc = parseIdentity({ v: 1, schema: "fil-identity/v1", address: ME, displayName: "Ada", updatedAt: new Date(0).toISOString() })!;
    const wrapKey = ("0x04" + "11".repeat(64)) as Hex;
    const withKey = withMemberKey(doc, { address: KEY, wrapKey });
    const reparsed = parseIdentity(JSON.stringify(withKey), ME);
    expect(memberKeyOf(reparsed)).toEqual({ address: "0x00000000000000000000000000000000000000C3", wrapKey });
    expect(memberKeyOf(doc)).toBeNull();
  });

  it("parses person links", () => {
    expect(personFromLink(`https://fifolders.scionbase.ai/person/?id=${ME}#v=pg1&k=x`)?.fragment).toBe("v=pg1&k=x");
    expect(personFromLink(ME)?.address.toLowerCase()).toBe(ME);
    expect(personFromLink("https://x/person/")).toBeNull();
  });

  it("finds my groups with a folder and my stored key", async () => {
    const calls: string[] = [];
    const word = (n: bigint) => n.toString(16).padStart(64, "0");
    const call = async (to: string, data: string) => {
      calls.push(data.slice(0, 10));
      const sel = data.slice(2, 10);
      if (sel === "3c2b9cf4") return "0x" + word(32n) + word(1n) + word(7n); // clubsOf → [7]
      if (sel === "5adf16af") return "0x" + word(32n) + word(4n) + Buffer.from("Crew").toString("hex").padEnd(64, "0");
      if (sel === "c4d63bd4") return "0x" + word(32n) + word(1n) + ME.slice(2).padStart(64, "0");
      if (sel === "7f8e156a") return "0x" + word(32n) + word(1n) + ADMIN.slice(2).padStart(64, "0");
      if (data.startsWith(encodeSelector("folderOf"))) return encodeFunctionResult({ abi: FICLUB_VAULT_ABI, functionName: "folderOf", result: ["0x7b7d", 1n] });
      if (data.startsWith(encodeSelector("grantsOf"))) {
        const { args } = decodeFunctionData({ abi: FICLUB_VAULT_ABI, data: data as Hex });
        const members = args![1] as string[];
        return encodeFunctionResult({
          abi: FICLUB_VAULT_ABI,
          functionName: "grantsOf",
          result: members.map((m) =>
            m.toLowerCase() === ME ? { memberKey: KEY, updatedAt: 5n, by: ADMIN, delivery: "0x01", entry: "0x02" } : { memberKey: "0x0000000000000000000000000000000000000000", updatedAt: 0n, by: "0x0000000000000000000000000000000000000000", delivery: "0x", entry: "0x" },
          ) as never,
        });
      }
      throw new Error("unexpected " + data.slice(0, 10) + " to " + to);
    };
    const groups = await findMyGroups(ME, { call, cache: null });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.club.name).toBe("Crew");
    expect(groups[0]!.status).toBe("ready");
    expect(groups[0]!.grant?.memberKey.toLowerCase()).toBe(KEY);
    expect(encodeGrant(7n, ME, KEY, new Uint8Array([1]))).toMatch(/^0x/);
  });
});

function encodeSelector(name: "folderOf" | "grantsOf"): string {
  const sample = name === "folderOf" ? { functionName: name, args: [1n] } : { functionName: name, args: [1n, []] };
  return (encodeFunctionDataSafe(sample) as string).slice(0, 10);
}
import { encodeFunctionData } from "viem";
function encodeFunctionDataSafe(x: { functionName: string; args: unknown[] }) {
  return encodeFunctionData({ abi: FICLUB_VAULT_ABI, ...(x as object) } as never);
}
