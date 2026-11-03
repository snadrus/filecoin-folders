import { saveIdentity, resolveIdentity, type PointerRegistry } from "fiperson/edit";
import type { Address } from "viem";
import { INTENTS, watchWalletPrompts, withWalletIntent } from "../wallet-prompts.js";
import { IdentityBlocked, type IdentityIO } from "./io.js";

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
    return { pieceCid: new TextEncoder().encode(cid), version: cid ? 1n : 0n };
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
      // Same fiperson/edit save path as live; the injected wallet sees a typed-data signature then a transaction.
      const storage = {
        put: async (bytes: Uint8Array) => {
          await p.request({ method: "eth_signTypedData_v4", params: [address, "{}"] });
          const pieceCid = `bafkzcibe2e${Date.now().toString(36)}`;
          const pieces = readMap(PIECES);
          pieces[pieceCid] = btoa(String.fromCharCode(...bytes));
          localStorage.setItem(PIECES, JSON.stringify(pieces));
          return { pieceCid };
        },
      };
      const registry: PointerRegistry = {
        head: (owner) => head(owner),
        commit: async (input) => {
          await p.request({ method: "eth_sendTransaction", params: [{ from: address }] });
          const heads = readMap(HEADS);
          heads[address.toLowerCase()] = new TextDecoder().decode(input.pieceCid);
          localStorage.setItem(HEADS, JSON.stringify(heads));
          return { pieceCid: input.pieceCid, version: 1n };
        },
      };
      return saveIdentity(identity, { storage, registry, onStep, withIntent: (intent, fn) => withWalletIntent(intent, fn) });
    },
  };
}
