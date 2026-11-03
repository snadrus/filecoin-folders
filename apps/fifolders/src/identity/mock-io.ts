import { decodeIdentity, encodeIdentity, identityPointerBytes, resolveIdentity } from "fil-folders";
import type { Address } from "viem";
import { INTENTS, watchWalletPrompts, withWalletIntent } from "../wallet-prompts.js";
import { IDENTITY_INTENTS, IdentityBlocked, type IdentityIO } from "./io.js";

type Provider = { request(args: { method: string; params?: unknown }): Promise<unknown> };

const PIECES = "identity-e2e:pieces";
const HEADS = "identity-e2e:heads";

function readMap(key: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * E2E/dev IO: real calls to the injected provider (so wallet toasts show), storage and chain in localStorage.
 * `?blocked=payments` simulates a wallet without storage payments.
 */
export function createMockIdentityIO(params = new URLSearchParams(location.search)): IdentityIO {
  const raw = (window as unknown as { ethereum?: Provider }).ethereum;
  const provider = raw ? watchWalletPrompts(raw) : null;
  const need = () => {
    if (!provider) throw new Error("No browser wallet found. Install one such as MetaMask.");
    return provider;
  };
  const head = async (owner: Address) => {
    const cid = readMap(HEADS)[owner.toLowerCase()] ?? "";
    return { pieceCid: identityPointerBytes(cid), version: cid ? 1n : 0n };
  };
  const fetchPiece = async (cid: string) => Uint8Array.from(atob(readMap(PIECES)[cid] ?? ""), (c) => c.charCodeAt(0));
  return {
    async peek() {
      const accounts = provider ? ((await provider.request({ method: "eth_accounts" })) as string[]) : [];
      return accounts?.[0]?.toLowerCase() || null;
    },
    async connect() {
      const p = need();
      const accounts = (await withWalletIntent(INTENTS.connect, () => p.request({ method: "eth_requestAccounts" }))) as string[];
      return accounts[0]!.toLowerCase();
    },
    load: (address) => resolveIdentity(address, { head, fetchPiece, force: true }),
    async save(address, identity, onStep) {
      if (params.get("blocked") === "payments") throw new IdentityBlocked("Storage payments are not set up for this wallet. Finish setup in FiFolders (it shows the cost first), then save again.");
      const p = need();
      const bytes = encodeIdentity(identity);
      if (!decodeIdentity(bytes, address)) throw new Error("bad identity");
      onStep("Storing your identity piece…");
      await withWalletIntent(IDENTITY_INTENTS.upload, () => p.request({ method: "eth_signTypedData_v4", params: [address, "{}"] }));
      const pieceCid = `bafkzcibe2e${Date.now().toString(36)}`;
      const pieces = readMap(PIECES);
      pieces[pieceCid] = btoa(String.fromCharCode(...bytes));
      localStorage.setItem(PIECES, JSON.stringify(pieces));
      onStep("Linking it to your wallet…");
      await withWalletIntent(IDENTITY_INTENTS.pointer, () => p.request({ method: "eth_sendTransaction", params: [{ from: address }] }));
      const heads = readMap(HEADS);
      heads[address.toLowerCase()] = pieceCid;
      localStorage.setItem(HEADS, JSON.stringify(heads));
      return { pieceCid, version: "1" };
    },
  };
}
