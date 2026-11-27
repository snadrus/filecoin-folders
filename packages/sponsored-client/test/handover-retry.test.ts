import { describe, expect, it } from "vitest";
import { withHandoverRetry, type HandoverRetryStatus } from "../src/credits.js";

describe("withHandoverRetry", () => {
  it("retries a rejected call until it succeeds, while handover is not confirmed", async () => {
    let calls = 0;
    const states: HandoverRetryStatus[] = [];
    const value = await withHandoverRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("not ready");
        return "ok";
      },
      { isConfirmed: () => false, onStatus: (state) => states.push(state), intervalMs: 1, timeoutMs: 5_000 },
    );
    expect(value).toBe("ok");
    expect(calls).toBe(3);
    expect(states).toEqual(["retrying", "retrying", "confirmed"]);
  });

  it("surfaces the first rejection after handover is confirmed", async () => {
    const states: HandoverRetryStatus[] = [];
    await expect(
      withHandoverRetry(
        async () => {
          throw new Error("revert after setup");
        },
        { isConfirmed: () => true, onStatus: (state) => states.push(state), intervalMs: 1, timeoutMs: 5_000 },
      ),
    ).rejects.toThrow(/revert after setup/);
    expect(states).toEqual(["failed"]);
  });
});
