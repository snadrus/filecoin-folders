import { describe, expect, it } from "vitest";
import { friendlyError } from "../src/friendly-error";

describe("friendlyError", () => {
  it("turns viem's HTTP failure dump into one sentence naming the host", () => {
    const raw = 'HTTP request failed. URL: https://api.calibration.node.glif.io/rpc/v1 Request body: {"method":"eth_getBalance"} Details: Failed to fetch Version: viem@2.57.14';
    expect(friendlyError(raw)).toBe("Can't reach the Filecoin network (api.calibration.node.glif.io). Check your connection, then try again.");
  });
  it("leaves other messages alone", () => {
    expect(friendlyError("Signature rejected — nothing was saved.")).toBe("Signature rejected — nothing was saved.");
    expect(friendlyError("")).toBe("");
  });
});
