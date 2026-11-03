import { describe, expect, it } from "vitest";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, parseAbi, toFunctionSelector } from "viem";
import { cachedCoworkers, findMyClubs, type EthCall } from "../src/clubs/index.js";

const abi = parseAbi([
  "function clubsOf(address account, uint256 offset, uint256 limit) view returns (uint256[] out)",
  "function getClub(uint256 clubId) view returns (string name, bytes metadata, address creator, uint64 createdAt, uint256 nonce)",
  "function listMembers(uint256 clubId, uint256 offset, uint256 limit) view returns (address[])",
  "function listAdmins(uint256 clubId, uint256 offset, uint256 limit) view returns (address[])",
]);
const me = "0x1111111111111111111111111111111111111111";
const bea = "0x2222222222222222222222222222222222222222";
const carl = "0x3333333333333333333333333333333333333333";

function memoryKV() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("findMyClubs", () => {
  it("selectors match the FiClub ABI", () => {
    expect(toFunctionSelector("clubsOf(address,uint256,uint256)")).toBe("0x3c2b9cf4");
    expect(toFunctionSelector("getClub(uint256)")).toBe("0x5adf16af");
  });
  it("scans clubsOf + members/admins, caches coworkers (dedup, without me)", async () => {
    const clubs: Record<string, { name: string; members: string[]; admins: string[] }> = {
      "3": { name: "Acme ✨", members: [me, bea], admins: [bea] },
      "7": { name: "Ops", members: [carl, bea], admins: [me] },
    };
    const call: EthCall = async (_to, data) => {
      const { functionName, args } = decodeFunctionData({ abi, data: data as `0x${string}` });
      if (functionName === "clubsOf") return encodeFunctionResult({ abi, functionName, result: [7n, 3n] });
      const c = clubs[String(args![0])]!;
      if (functionName === "getClub") return encodeFunctionResult({ abi, functionName, result: [c.name, "0x", bea, 1n, 0n] });
      return encodeFunctionResult({ abi, functionName, result: (functionName === "listMembers" ? c.members : c.admins) as `0x${string}`[] });
    };
    const kv = memoryKV();
    const got = await findMyClubs(me, { call, cache: kv });
    expect(got.clubs.map((c) => [c.id, c.name, c.role])).toEqual([["3", "Acme ✨", "member"], ["7", "Ops", "admin"]]);
    expect(got.coworkers).toEqual([bea, carl]);
    expect(cachedCoworkers(me, kv)).toEqual([{ address: bea, clubs: ["Acme ✨", "Ops"] }, { address: carl, clubs: ["Ops"] }]);
    void createPublicClient; void custom;
  });
});
