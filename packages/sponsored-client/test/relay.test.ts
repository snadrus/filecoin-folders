import { describe, expect, it } from "vitest";
import { filecoinCalibration } from "viem/chains";
import type { Hex } from "viem";
import { sponsoredTransport } from "../src/relay.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as const;
const TARGET = "0x9C06335D7DE588Caa104ee4FC3bb7cd8Aba62443" as const;

describe("sponsoredTransport", () => {
  const transport = sponsoredTransport({ rpc: "http://rpc", chainId: 314159, account: ACCOUNT, sessionKey: KEY })({ chain: filecoinCalibration });

  it("rejects contract deploys and value transfers", async () => {
    await expect(transport.request({ method: "eth_sendTransaction", params: [{ data: "0x" }] } as never)).rejects.toThrow(/cannot deploy/);
    await expect(transport.request({ method: "eth_sendTransaction", params: [{ to: TARGET, value: "0x1" }] } as never)).rejects.toThrow(/value/);
  });
});
