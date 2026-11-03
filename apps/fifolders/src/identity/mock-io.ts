import { saveIdentity, resolveIdentity, type PointerRegistry } from "fiperson/edit";
import { findMyClubs, type EthCall } from "fiperson/clubs";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
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
    async findClubs(address) {
      // Same scanner as live, over the /ficlub/ mock's localStorage clubs (ficlub:mock:v1).
      const found = await findMyClubs(address, { call: mockClubCall(), contract: "0x0000000000000000000000000000000000000c1b" });
      await Promise.all(found.coworkers.map((a) => resolveIdentity(a, { head, fetchPiece, force: true }).catch(() => null)));
      return found;
    },
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

const CLUB_ABI = parseAbi([
  "function clubsOf(address account, uint256 offset, uint256 limit) view returns (uint256[] out)",
  "function getClub(uint256 clubId) view returns (string name, bytes metadata, address creator, uint64 createdAt, uint256 nonce)",
  "function listMembers(uint256 clubId, uint256 offset, uint256 limit) view returns (address[])",
  "function listAdmins(uint256 clubId, uint256 offset, uint256 limit) view returns (address[])",
]);

/** eth_call against the FiClub mock state so the real fiperson/clubs decoder runs in e2e. */
function mockClubCall(): EthCall {
  type C = { id: string; name: string; creator: Address; members: Address[]; admins: Address[] };
  const clubs = (): C[] => {
    try {
      return (JSON.parse(localStorage.getItem("ficlub:mock:v1") || "{}") as { clubs?: C[] }).clubs ?? [];
    } catch {
      return [];
    }
  };
  return async (_to, data) => {
    const { functionName, args } = decodeFunctionData({ abi: CLUB_ABI, data: data as `0x${string}` });
    const all = clubs();
    if (functionName === "clubsOf") {
      const who = String(args![0]).toLowerCase();
      const ids = all.filter((c) => [...c.members, ...c.admins].some((m) => m.toLowerCase() === who)).map((c) => BigInt(c.id));
      return encodeFunctionResult({ abi: CLUB_ABI, functionName, result: ids });
    }
    const c = all.find((x) => x.id === String(args![0]));
    if (!c) throw new Error("No such club");
    if (functionName === "getClub") return encodeFunctionResult({ abi: CLUB_ABI, functionName, result: [c.name, "0x", c.creator, 0n, 0n] });
    const list = (functionName === "listMembers" ? c.members : c.admins).map((a) => a.toLowerCase() as Address);
    return encodeFunctionResult({ abi: CLUB_ABI, functionName, result: list });
  };
}
