// Live, opt-in (RECOVER_LIVE=1, Calibration only): proves the recovery path against real FEVM semantics.
//  1. Create a brand-new t1 account actor (FilForwarder, the standard EVM→f1 bridge) and read its actor ID.
//  2. Fund a throwaway EVM wallet from the Calibration sponsor (SPONSOR_KEY) with a little tFIL and USDFC.
//  3. Run recoverAll from the throwaway with the t1's *masked-ID* 0xff… address as both recipients.
//  4. Check via Lotus that the t1 actor received the FIL and the token credited the masked-ID address.
import { blake2b } from "@noble/hashes/blake2b";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, parseAbi, parseEther, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { evmRecoveryChain } from "../sponsor/recover-chain.js";
import { lotusLookupId, maskedIdAddress, recoverAll, resolveRecipient } from "../sponsor/recoverlib.js";
import { SponsorWalletRelayer, publicClient, rpcFor } from "../sponsor/relayer.js";

const live = process.env.RECOVER_LIVE === "1" && !!process.env.SPONSOR_KEY;
const FIL_FORWARDER = getAddress("0x2B3ef6906429b580b7b2080de5CA893BC282c225");
const USDFC = getAddress("0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0");

function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) out += alphabet[(value >>> (bits -= 5)) & 31];
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
/** t1/f1 string for a 20-byte secp256k1 payload. */
export function secpAddress(payload: Uint8Array, prefix: "t" | "f"): string {
  const checksum = blake2b(new Uint8Array([1, ...payload]), { dkLen: 4 });
  return `${prefix}1${base32(new Uint8Array([...payload, ...checksum]))}`;
}

async function lotus<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcFor("calibration"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

describe("f1 checksum", () => {
  it("encodes Andy's mainnet f1 round-trip", async () => {
    // f1ncgcm7zu25ouka3tnbvuscjcpl3spqg7rdl63wa: decode the payload and re-encode it.
    const s = "ncgcm7zu25ouka3tnbvuscjcpl3spqg7rdl63wa";
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    let bits = 0, value = 0;
    const out: number[] = [];
    for (const c of s) {
      value = (value << 5) | alphabet.indexOf(c);
      bits += 5;
      if (bits >= 8) out.push((value >>> (bits -= 8)) & 255);
    }
    expect(secpAddress(new Uint8Array(out.slice(0, 20)), "f")).toBe(`f1${s}`);
  });
});

describe.skipIf(!live)("recovery on Calibration (live)", () => {
  it("FIL and USDFC reach an f1 through its masked-ID address", async () => {
    const pub = publicClient({ network: "calibration" });
    const sponsor = new SponsorWalletRelayer(process.env.SPONSOR_KEY as Hex, { network: "calibration" });
    const log: Record<string, unknown> = {};

    // 1. New t1 actor (random payload: nobody holds its key; the few tFIL sent there are gone).
    const payload = crypto.getRandomValues(new Uint8Array(20));
    const t1 = secpAddress(payload, "t");
    const create = await sponsor.relay({ to: FIL_FORWARDER, value: parseEther("0.0001"), label: `FilForwarder → ${t1}`, data: encodeFunctionData({ abi: parseAbi(["function forward(bytes destination) payable"]), functionName: "forward", args: [toHex(new Uint8Array([1, ...payload]))] }) });
    const id = await lotus<string>("Filecoin.StateLookupID", [t1, null]);
    const masked = maskedIdAddress(id.slice(2));
    expect(await resolveRecipient(t1, "calibration", lotusLookupId(rpcFor("calibration")))).toBe(masked);
    const before = BigInt(await lotus<string>("Filecoin.WalletBalance", [t1]));
    Object.assign(log, { t1, id, masked, create: create.transactionHash, before: formatUnits(before, 18) });

    // 2. Throwaway wallet funded by the sponsor.
    const key = generatePrivateKey();
    const temp = privateKeyToAccount(key).address;
    await sponsor.relay({ to: temp, value: parseEther("0.003"), data: "0x", label: "fund throwaway tFIL" });
    await sponsor.relay({ to: USDFC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [temp, parseEther("0.01")] }), label: "fund throwaway USDFC" });

    // 3. Recover everything to the masked-ID address.
    const chain = evmRecoveryChain({ key, network: "calibration", rpc: rpcFor("calibration") });
    const report = await recoverAll(chain, { filTo: masked, usdfcTo: masked, usdfc: USDFC, dryRun: false, log: (line) => console.log(line) });
    log.steps = report.steps;

    // 4. Delivered.
    const after = BigInt(await lotus<string>("Filecoin.WalletBalance", [t1]));
    expect(after - before).toBe(report.fil.sent);
    expect(report.fil.sent).toBeGreaterThan(parseEther("0.002"));
    expect(await pub.readContract({ address: USDFC, abi: erc20Abi, functionName: "balanceOf", args: [masked as Address] })).toBe(parseEther("0.01"));
    expect(report.usdfc.after).toBe(0n);
    log.leftFil = formatUnits(report.fil.after!, 18); // refund of unused gas only
    log.received = formatUnits(after - before, 18);
    console.log(JSON.stringify(log, null, 2));
  }, 15 * 60_000);
});
