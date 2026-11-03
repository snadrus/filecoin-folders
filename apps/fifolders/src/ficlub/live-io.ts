/** FiClub on chain via viem. Address from VITE_FICLUB_ADDRESS_CALIBRATION (or a local anvil via VITE_FICLUB_RPC + VITE_FICLUB_CHAIN_ID). */
import { createPublicClient, createWalletClient, custom, defineChain, getAddress, http, parseEventLogs, type Address, type Chain, type Hex } from "viem";
import { filecoinCalibration } from "viem/chains";
import { withWalletIntent } from "../wallet-prompts.js";
import { FICLUB_ABI } from "./abi.js";
import type { ClubView, RemovalBlob } from "./core.js";
import { REMOVE_ADMIN_TYPES, domainOf } from "./core.js";
import { CLUB_INTENTS, type ClubIO } from "./io.js";
import { connectAccount, getProvider, peekAccount } from "./wallet.js";

const PAGE = 200n;

export function createLiveClubIO(address: Address, rpc?: string, chainId?: number): ClubIO {
  const chain: Chain = rpc
    ? defineChain({ id: chainId ?? 31337, name: "Local", nativeCurrency: { name: "FIL", symbol: "FIL", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
    : (filecoinCalibration as Chain);
  const client = createPublicClient({ chain, transport: http(rpc ?? "https://api.calibration.node.glif.io/rpc/v1") });
  let me: Address | null = null;

  async function wallet() {
    const p = await getProvider();
    return createWalletClient({ account: me!, chain, transport: custom(p) });
  }
  async function write(intent: (typeof CLUB_INTENTS)[keyof typeof CLUB_INTENTS], functionName: string, args: unknown[]): Promise<Hex> {
    const { request } = await client.simulateContract({ address, abi: FICLUB_ABI, functionName: functionName as never, args: args as never, account: me! });
    const w = await wallet();
    const hash = await withWalletIntent(intent, () => w.writeContract(request as never));
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${intent.title} failed on chain`);
    return hash;
  }
  async function page(fn: "listMembers" | "listAdmins", id: bigint): Promise<Address[]> {
    const out: Address[] = [];
    for (let off = 0n; ; off += PAGE) {
      const got = (await client.readContract({ address, abi: FICLUB_ABI, functionName: fn, args: [id, off, PAGE] })) as Address[];
      out.push(...got);
      if (BigInt(got.length) < PAGE) return out;
    }
  }
  async function getClub(id: bigint): Promise<ClubView> {
    const [name, , creator, , nonce] = (await client.readContract({ address, abi: FICLUB_ABI, functionName: "getClub", args: [id] })) as [string, Hex, Address, bigint, bigint];
    const [members, admins] = await Promise.all([page("listMembers", id), page("listAdmins", id)]);
    return { id, name, creator, nonce, members, admins };
  }

  return {
    mode: "live",
    chainId: chain.id,
    contract: address,
    peek: async () => (me = await peekAccount()),
    connect: async () => (me = await connectAccount()),
    async listClubs(addr) {
      const ids = (await client.readContract({ address, abi: FICLUB_ABI, functionName: "clubsOf", args: [addr, 0n, 1000n] })) as bigint[];
      return Promise.all([...ids].sort((a, b) => Number(a - b)).map(getClub));
    },
    getClub,
    async createClub(name) {
      const hash = await write(CLUB_INTENTS.create, "createClub", [name, "0x"]);
      const receipt = await client.getTransactionReceipt({ hash });
      const ev = parseEventLogs({ abi: FICLUB_ABI, logs: receipt.logs, eventName: "ClubCreated" })[0] as unknown as { args: { clubId: bigint } };
      return ev.args.clubId;
    },
    addMember: async (id, who) => void (await write(CLUB_INTENTS.addMember, "addMember", [id, getAddress(who)])),
    removeMember: async (id, who) => void (await write(CLUB_INTENTS.removeMember, "removeMember", [id, getAddress(who)])),
    addAdmin: async (id, who) => void (await write(CLUB_INTENTS.addAdmin, "addAdmin", [id, getAddress(who)])),
    removeAdmin: async (id, who) => void (await write(CLUB_INTENTS.removeAdmin, "removeAdmin", [id, getAddress(who)])),
    async signRemoval(signer, c, target, deadline, step) {
      const w = await wallet();
      return withWalletIntent(step === 2 ? CLUB_INTENTS.sign2 : CLUB_INTENTS.sign1, () =>
        w.signTypedData({ account: signer, domain: domainOf(chain.id, address), types: REMOVE_ADMIN_TYPES, primaryType: "RemoveAdmin", message: { clubId: c.id, target, nonce: c.nonce, deadline } }),
      );
    },
    submitRemoval: async (blob: RemovalBlob, sig2: Hex) =>
      void (await write(CLUB_INTENTS.submit, "removeAdminWithSignatures", [BigInt(blob.clubId), blob.target, BigInt(blob.deadline), blob.sig1, sig2])),
  };
}
