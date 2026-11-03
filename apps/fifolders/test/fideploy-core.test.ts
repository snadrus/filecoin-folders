import { describe, expect, it } from "vitest";
import { decodeAbiParameters } from "viem";
import { ARTIFACTS, CHAINS, chainInfo, codeStatus, deployData, deploymentsJson, formatCost, loadPrivate, savePrivate } from "../src/fideploy/core.js";

const OWNER = "0x2d633437f7E2138B400AF6882bee2d79C81CF401";
describe("fideploy core", () => {
  it("known chains carry the canonical SessionKeyRegistry", () => {
    expect(CHAINS[314]!.known.SessionKeyRegistry).toBe("0x74FD50525A958aF5d484601E252271f9625231aB");
    expect(CHAINS[314159]!.known.SessionKeyRegistry).toBe("0x518411c2062E119Aaf7A8B12A2eDf9a939347655");
    expect(chainInfo(31337, "http://x").testnet).toBe(true);
  });
  it("bytecode status", () => {
    const code = ARTIFACTS.FiClub.deployedBytecode;
    expect(codeStatus(code, code)).toBe("match");
    expect(codeStatus(code.toUpperCase().replace("0X", "0x") as never, code)).toBe("match");
    expect(codeStatus("0x", code)).toBe("absent");
    expect(codeStatus("0x6000", code)).toBe("different");
    expect(codeStatus("0x6000")).toBe("match");
  });
  it("FolderRegistryV2 deploy data = bytecode + (owner, skr)", () => {
    const skr = CHAINS[314159]!.known.SessionKeyRegistry!;
    const data = deployData("FolderRegistryV2", OWNER, skr);
    const tail = `0x${data.slice(ARTIFACTS.FolderRegistryV2.bytecode.length)}` as const;
    expect(decodeAbiParameters([{ type: "address" }, { type: "address" }], tail)).toEqual([OWNER, skr]);
    expect(() => deployData("FolderRegistryV2", OWNER)).toThrow(/SessionKeyRegistry/);
    expect(deployData("FiClub", OWNER)).toBe(ARTIFACTS.FiClub.bytecode);
  });
  it("cost formatting rounds up", () => {
    expect(formatCost(57_766_448n, 100_000_000n)).toBe("~0.0058 FIL");
  });
  it("records persist per chain and JSON names the network", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    savePrivate(314159, { contract: "FiClub", address: OWNER, verified: "match", date: "2026-11-03" }, store);
    expect(loadPrivate(314159, store)).toHaveLength(1);
    expect(loadPrivate(314, store)).toHaveLength(0);
    expect(JSON.parse(deploymentsJson(CHAINS[314159]!, loadPrivate(314159, store))).network).toBe("filecoin-calibration");
  });
});
