import { describe, expect, it } from "vitest";
import { waitForReceipt } from "../src/receipt.js";

describe("waitForReceipt", () => {
  it("keeps polling through not-found and null-round errors", async () => {
    let calls = 0;
    const client = {
      async getTransactionReceipt() {
        calls += 1;
        if (calls === 1) throw new Error("Transaction receipt not found");
        if (calls === 2) throw new Error("requested epoch was a null round (4279844)");
        return { status: "success" } as never;
      },
    };
    expect((await waitForReceipt(client, "0x01", { pollMs: 1 })).status).toBe("success");
    expect(calls).toBe(3);
  });
  it("times out with the last error", async () => {
    const client = { getTransactionReceipt: async () => { throw new Error("not found"); } };
    await expect(waitForReceipt(client, "0x02", { pollMs: 1, timeoutMs: 5 })).rejects.toThrow(/timed out.*not found/);
  });
});
