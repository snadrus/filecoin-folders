/** In-memory FiClub for tests / before deployment. Wallet prompts still go through the injected provider (labeled toasts). */
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { withWalletIntent } from "../wallet-prompts.js";
import type { ClubView, RemovalBlob } from "./core.js";
import { typedDataJson } from "./core.js";
import { CLUB_INTENTS, type ClubIO } from "./io.js";
import { connectAccount, getProvider, peekAccount } from "./wallet.js";

const KEY = "ficlub:mock:v1";
interface Stored { clubs: { id: string; name: string; creator: Address; nonce: string; members: Address[]; admins: Address[] }[] }

function load(): Stored {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "") as Stored;
  } catch {
    return { clubs: [] };
  }
}
function save(s: Stored): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const view = (c: Stored["clubs"][number]): ClubView => ({ ...c, id: BigInt(c.id), nonce: BigInt(c.nonce) });

export function createMockClubIO(): ClubIO {
  /** Mock signatures are opaque; remember who produced each so submit can enforce the contract's rules. */
  const signers = new Map<string, Address>();
  let me: Address | null = null;

  async function tx(intent: (typeof CLUB_INTENTS)[keyof typeof CLUB_INTENTS], fn: (s: Stored) => void): Promise<void> {
    const p = await getProvider();
    const s = load();
    fn(s); // validate before prompting, like a gas estimate would
    await withWalletIntent(intent, () => p.request({ method: "eth_sendTransaction", params: [{ from: me, to: zeroAddress, data: "0x" }] }));
    save(s);
  }
  function club(s: Stored, id: bigint) {
    const c = s.clubs.find((x) => x.id === id.toString());
    if (!c) throw new Error("No such club");
    return c;
  }
  function admin(c: Stored["clubs"][number]) {
    if (!me || !c.admins.some((a) => same(a, me!))) throw new Error("Only admins can do that");
  }

  return {
    mode: "mock",
    chainId: 314159,
    contract: zeroAddress,
    async peek() {
      return (me = await peekAccount());
    },
    async connect() {
      return (me = await connectAccount());
    },
    async listClubs(addr) {
      return load().clubs.filter((c) => [...c.members, ...c.admins].some((a) => same(a, addr))).map(view);
    },
    async getClub(id) {
      return view(club(load(), id));
    },
    async createClub(name) {
      let id = 0n;
      await tx(CLUB_INTENTS.create, (s) => {
        id = BigInt(s.clubs.length + 1);
        s.clubs.push({ id: id.toString(), name, creator: me!, nonce: "0", members: [me!], admins: [me!] });
      });
      return id;
    },
    addMember: (id, who) =>
      tx(CLUB_INTENTS.addMember, (s) => {
        const c = club(s, id);
        admin(c);
        if (c.members.some((a) => same(a, who))) throw new Error("Already a member");
        c.members.push(getAddress(who));
      }),
    removeMember: (id, who) =>
      tx(CLUB_INTENTS.removeMember, (s) => {
        const c = club(s, id);
        admin(c);
        if (!c.members.some((a) => same(a, who))) throw new Error("Not a member");
        c.members = c.members.filter((a) => !same(a, who));
      }),
    addAdmin: (id, who) =>
      tx(CLUB_INTENTS.addAdmin, (s) => {
        const c = club(s, id);
        admin(c);
        if (c.admins.some((a) => same(a, who))) throw new Error("Already an admin");
        c.admins.push(getAddress(who));
      }),
    removeAdmin: (id, who) =>
      tx(CLUB_INTENTS.removeAdmin, (s) => {
        const c = club(s, id);
        admin(c);
        if (c.admins.length > 2) throw new Error("3+ admins: removal needs 2 admin signatures");
        if (c.admins.length === 1) throw new Error("Cannot remove the last admin");
        c.admins = c.admins.filter((a) => !same(a, who));
      }),
    async signRemoval(signer, c, target, deadline, step) {
      const p = await getProvider();
      const intent = step === 2 ? CLUB_INTENTS.sign2 : CLUB_INTENTS.sign1;
      const data = typedDataJson(314159, zeroAddress, { clubId: c.id, target, nonce: c.nonce, deadline });
      const sig = (await withWalletIntent(intent, () => p.request({ method: "eth_signTypedData_v4", params: [signer, data] }))) as Hex;
      // Mock wallets may return a constant; make it unique per signer so duplicates are detectable.
      const unique = (sig.slice(0, 92) + signer.slice(2).toLowerCase()) as Hex;
      signers.set(unique, signer);
      localStorage.setItem("ficlub:mock:sig:" + unique, signer);
      return unique;
    },
    async submitRemoval(blob: RemovalBlob, sig2: Hex) {
      await tx(CLUB_INTENTS.submit, (s) => {
        const c = club(s, BigInt(blob.clubId));
        const s1 = blob.signer1;
        const s2 = signers.get(sig2) ?? (localStorage.getItem("ficlub:mock:sig:" + sig2) as Address | null);
        if (!s2) throw new Error("Bad signature");
        if (Number(blob.deadline) < Date.now() / 1000) throw new Error("Expired");
        if (blob.nonce !== c.nonce) throw new Error("Nonce moved (replay)");
        if (same(s1, s2)) throw new Error("Duplicate signer");
        if (![s1, s2].every((x) => c.admins.some((a) => same(a, x)))) throw new Error("Signer not admin");
        if (c.admins.length <= 2) throw new Error("Too few admins for signatures");
        if (!c.admins.some((a) => same(a, blob.target))) throw new Error("Target not admin");
        c.admins = c.admins.filter((a) => !same(a, blob.target));
        c.nonce = (BigInt(c.nonce) + 1n).toString();
      });
    },
  };
}
