/**
 * Visible "check your wallet" state for every request that pops the wallet UI.
 * A rejection keeps the call open: the user can Retry (same request again) or Cancel (rejects).
 */
export interface WalletPrompt {
  id: number;
  what: string;
  state: "waiting" | "rejected";
  retry: () => void;
  cancel: () => void;
}

type Listener = (prompts: WalletPrompt[]) => void;

const PROMPTING: Record<string, string> = {
  eth_requestAccounts: "the connection",
  wallet_requestPermissions: "the connection",
  personal_sign: "the signature",
  eth_sign: "the signature",
  eth_signTypedData_v4: "the signature",
  eth_signTypedData: "the signature",
  eth_sendTransaction: "the transaction",
  wallet_switchEthereumChain: "the network switch",
  wallet_addEthereumChain: "adding the network",
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
  return PROMPTING[method] ?? null;
}

interface Requester {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

/** Wrap an EIP-1193 provider so prompting calls show the wallet toast. Idempotent. */
export function watchWalletPrompts<T extends Requester>(provider: T): T {
  if ((provider as { __fifoldersPrompts?: boolean }).__fifoldersPrompts) return provider;
  const original = provider.request.bind(provider);
  const request = (args: { method: string; params?: unknown }) => {
    const what = promptLabel(args.method);
    if (!what) return original(args);
    return new Promise((resolve, reject) => {
      const prompt: WalletPrompt = {
        id: ++seq,
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
  // Proxy, not a prototype copy: wallet providers keep private fields that need the real `this`.
  return new Proxy(provider, {
    get(target, key) {
      if (key === "request") return request;
      if (key === "__fifoldersPrompts") return true;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
