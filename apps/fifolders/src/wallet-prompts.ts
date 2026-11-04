/**
 * Visible "check your wallet" state for every request that pops the wallet UI.
 * A rejection keeps the call open: the user can Retry (same request again) or Cancel (rejects).
 */
export interface WalletIntent {
  /** Plain name, e.g. "Connect wallet". */
  title: string;
  /** What it lets FiFolders do. */
  purpose?: string;
  /** Expected cost, e.g. "free" or "~0.05 FIL". */
  cost: string;
  /** Flows that already write their own Transaction-log row. */
  logged?: boolean;
}

/** Plain purpose for the Transaction log: what it is for, never "transaction" or gas wording. */
export function purposeText(intent: WalletIntent): string {
  switch (intent.title) {
    case "Authorize session key":
      return "Authorize this browser to save";
    case "Approve storage payments":
      return "Allow storage payments";
    case "Save changes":
      return `Save ${intent.purpose ?? "changes"} to My Folders`;
    case "Add to folders": {
      const n = /reference (\d+)/.exec(intent.purpose ?? "")?.[1] ?? "";
      return `Add ${n ? `${n} ` : ""}Filecoin Drive ${n === "1" ? "file" : "files"}`;
    }
    case "Create dataset":
      return "Create a storage dataset";
    case "Send transaction":
      return "Confirm a wallet request";
    case "Sign message":
      return "Sign with your wallet";
    default:
      return intent.title;
  }
}

/** Legacy stored labels like "Send transaction (gas)" or "X — purpose (~0.05 FIL)": keep the purpose only. */
export function cleanOpLabel(label: string): string {
  if (/^Send transaction\b/.test(label)) return "Confirm a wallet request";
  if (/^Authorize session key\b/.test(label)) return "Authorize this browser to save";
  if (/^Approve storage payments\b/.test(label)) return "Allow storage payments";
  return label.replace(/\s*\([^()]*\)\s*$/, "").replace(/\s+—\s+.*$/, "");
}

export function intentText(intent: WalletIntent): string {
  return `${intent.title}${intent.purpose ? ` — ${intent.purpose}` : ""} (${intent.cost})`;
}

/** Every prompting call site in FiFolders, named for the user. */
export const INTENTS = {
  connect: { title: "Connect wallet", cost: "free" },
  switchNetwork: { title: "Switch network", purpose: "use Filecoin Calibration", cost: "free" },
  addNetwork: { title: "Add network", purpose: "add Filecoin Calibration to your wallet", cost: "free" },
  approvePayments: {
    title: "Approve storage payments",
    purpose: "lets Filecoin Warm Storage charge your USDFC deposit",
    cost: "no cost now; gas ~0.01 FIL",
    logged: true,
  },
  depositAndApprove: (usdfc: string): WalletIntent => ({
    title: "Approve storage payments",
    purpose: `deposit ${usdfc} USDFC and let Filecoin Warm Storage charge it`,
    cost: `${usdfc} USDFC moves to your storage deposit; gas ~0.01 FIL`,
    logged: true,
  }),
  session: (days: number, fil: string): WalletIntent => ({
    title: "Authorize session key",
    purpose: `lets FiFolders save for ${days} days without asking each time`,
    cost: `~${fil} FIL`,
    logged: true,
  }),
  createDataset: { title: "Create dataset", purpose: "reserve storage with a provider", cost: "reserve $0.50 USDFC" },
  save: (pieces: number): WalletIntent => ({
    title: "Save changes",
    purpose: `${pieces} ${pieces === 1 ? "piece" : "pieces"}`,
    cost: "gas ~0.01 FIL",
  }),
  adopt: (files: number): WalletIntent => ({
    title: "Add to folders",
    purpose: `reference ${files} Filecoin Drive ${files === 1 ? "file" : "files"} in your folders without re-uploading`,
    cost: "one manifest commit; gas ~0.01 FIL + a penny for the manifest piece",
  }),
  unlock: { title: "Unlock encrypted folder", purpose: "your signature derives the folder key", cost: "free" },
  migrateDrive: { title: "Move folders pointer to new registry", purpose: "one-time move to FolderRegistry v2 (smaller chain data); history stays linked", cost: "gas ~0.01 FIL" },
  migrateIdentity: { title: "Move identity pointer to new registry", purpose: "one-time move to FolderRegistry v2", cost: "gas ~0.01 FIL" },
} as const;

/** keccak256("fil-identity"). */
const IDENTITY_NS = "0x4ba7e36ce925bbe5d8a219757e1186149701b3ee9649e24538dccda15e7c59e5";

/** `wrapMigration` for fil-folders registries: labels the one-time v1 → v2 pointer move. */
export function labelMigration<T>(info: { ns: string }, fn: () => Promise<T>): Promise<T> {
  return withWalletIntent(info.ns.toLowerCase() === IDENTITY_NS ? INTENTS.migrateIdentity : INTENTS.migrateDrive, fn);
}

let intent: WalletIntent | null = null;

/** Name every wallet prompt raised while `fn` runs. */
export async function withWalletIntent<T>(next: WalletIntent, fn: () => Promise<T>): Promise<T> {
  const previous = intent;
  intent = next;
  try {
    return await fn();
  } finally {
    intent = previous;
  }
}

export function currentIntent(): WalletIntent | null {
  return intent;
}

export interface WalletPrompt {
  id: number;
  intent: WalletIntent;
  what: string;
  state: "waiting" | "rejected";
  retry: () => void;
  cancel: () => void;
}

type Listener = (prompts: WalletPrompt[]) => void;

const SIGN: WalletIntent = { title: "Sign message", cost: "free" };
const PROMPTING: Record<string, WalletIntent> = {
  eth_requestAccounts: INTENTS.connect,
  wallet_requestPermissions: INTENTS.connect,
  personal_sign: SIGN,
  eth_sign: SIGN,
  eth_signTypedData_v4: SIGN,
  eth_signTypedData: SIGN,
  eth_sendTransaction: { title: "Send transaction", cost: "gas" },
  wallet_switchEthereumChain: INTENTS.switchNetwork,
  wallet_addEthereumChain: INTENTS.addNetwork,
};

let seq = 0;
let active: WalletPrompt[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(active);
}

export function onWalletPrompts(listener: Listener): () => void {
  listeners.add(listener);
  listener(active);
  return () => listeners.delete(listener);
}

export function walletPrompts(): WalletPrompt[] {
  return active;
}

export function isUserRejection(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown }; message?: unknown } | null;
  if (!e) return false;
  if (e.code === 4001 || e.cause?.code === 4001) return true;
  return typeof e.message === "string" && /user (rejected|denied)|rejected the request/i.test(e.message);
}

/** Describe a request for the toast, or null when it does not prompt. */
export function promptLabel(method: string): string | null {
  const fallback = PROMPTING[method];
  if (!fallback) return null;
  // Network calls keep their own name even inside a bigger flow.
  const named = method.startsWith("wallet_") || method === "eth_requestAccounts" ? fallback : (intent ?? fallback);
  return intentText(named);
}

function promptIntent(method: string): WalletIntent | null {
  const fallback = PROMPTING[method];
  if (!fallback) return null;
  return method.startsWith("wallet_") || method === "eth_requestAccounts" ? fallback : (intent ?? fallback);
}

interface Requester {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

/** Wrap an EIP-1193 provider so prompting calls show the wallet toast. Idempotent. */
/**
 * Read a provider member without throwing. A hostile injected Proxy can throw on a plain get (broken
 * invariant); the own-property descriptor (walking the prototype chain) still holds the real value.
 */
export function readMember(obj: unknown, key: PropertyKey): unknown {
  if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return undefined;
  try {
    return Reflect.get(obj as object, key, obj);
  } catch {
    try {
      for (let o: object | null = obj as object; o; o = Object.getPrototypeOf(o)) {
        const d = Object.getOwnPropertyDescriptor(o, key);
        if (d) return "value" in d ? d.value : undefined;
      }
    } catch {
      /* fully hostile */
    }
    return undefined;
  }
}

export function watchWalletPrompts<T extends Requester>(provider: T): T {
  if ((provider as { __fifoldersPrompts?: boolean }).__fifoldersPrompts) return provider;
  const requestFn = readMember(provider, "request");
  if (typeof requestFn !== "function") throw new Error("This wallet provider has no request method.");
  const original = (args: { method: string; params?: unknown }) => (requestFn as (a: typeof args) => Promise<unknown>).call(provider, args);
  const request = (args: { method: string; params?: unknown }) => {
    const named = promptIntent(args.method);
    if (!named) return original(args);
    const what = intentText(named);
    return new Promise((resolve, reject) => {
      const prompt: WalletPrompt = {
        id: ++seq,
        intent: named,
        what,
        state: "waiting",
        retry: () => attempt(),
        cancel: () => {
          finish();
          reject(Object.assign(new Error("Signature rejected"), { code: 4001 }));
        },
      };
      const finish = () => {
        active = active.filter((item) => item !== prompt);
        emit();
      };
      const attempt = () => {
        prompt.state = "waiting";
        if (!active.includes(prompt)) active = [...active, prompt];
        emit();
        original(args).then(
          (value) => {
            finish();
            resolve(value);
          },
          (error: unknown) => {
            if (!isUserRejection(error)) {
              finish();
              reject(error);
              return;
            }
            prompt.state = "rejected";
            emit();
          },
        );
      };
      attempt();
    });
  };
  // A delegate over a fresh target, never a Proxy over the provider itself: wallet extensions inject frozen
  // providers with non-configurable methods, and a Proxy over those that returns a bound copy throws
  // "'get' on proxy: property 'on' is a read-only and non-configurable data property". Methods still run
  // with the real provider as `this` (providers keep private fields). Reads never throw.
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(Object.create(null) as T, {
    get(_target, key) {
      if (key === "request") return request;
      if (key === "__fifoldersPrompts") return true;
      const value = readMember(provider, key);
      if (typeof value !== "function") return value;
      if (!bound.has(key)) bound.set(key, (value as (...a: unknown[]) => unknown).bind(provider));
      return bound.get(key);
    },
    has(_target, key) {
      try {
        return key === "request" || key === "__fifoldersPrompts" || key in (provider as object);
      } catch {
        return false;
      }
    },
  });
}

/** Session-key intent with FiFolders' own TTL and funding. */
export function sessionIntent(): WalletIntent {
  return INTENTS.session(7, "0.05");
}
