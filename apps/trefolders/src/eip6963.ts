import { readMember } from "./wallet-prompts.js";
export interface AnnouncedWallet {
  uuid: string;
  name: string;
  rdns: string;
  provider: Eip1193Provider;
}

const LEGACY_UUID = "fifolders:window.ethereum";

/** EIP-6963 announcements, plus `window.ethereum` when no announcer wrapped it. */
export function discoverWallets(timeoutMs = 60): Promise<AnnouncedWallet[]> {
  if (typeof window === "undefined") return Promise.resolve([]);
  const byUuid = new Map<string, AnnouncedWallet>();
  const onAnnounce = (event: Event): void => {
    const detail = (event as CustomEvent<{ info?: { uuid?: string; name?: string; rdns?: string }; provider?: Eip1193Provider }>).detail;
    let uuid: string | undefined;
    let provider: Eip1193Provider | undefined;
    try {
      uuid = detail?.info?.uuid;
      provider = detail?.provider;
      if (!uuid || !provider?.request) return;
    } catch {
      return;
    }
    byUuid.set(uuid, {
      uuid,
      name: detail.info?.name || "Wallet",
      rdns: detail.info?.rdns || uuid,
      provider,
    });
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return new Promise((resolve) => {
    window.setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const list = [...byUuid.values()];
      let ethereum: Eip1193Provider | undefined;
      try {
        ethereum = window.ethereum?.request ? window.ethereum : undefined;
      } catch {
        ethereum = undefined;
      }
      if (ethereum && !list.some((wallet) => wallet.provider === ethereum)) {
        list.push({ uuid: LEGACY_UUID, name: "Browser wallet", rdns: "window.ethereum", provider: ethereum });
      }
      resolve(list);
    }, timeoutMs);
  });
}

/** Subscribe to a provider event without ever throwing (hostile Proxy providers throw on `.on`). */
export function safeOn(provider: unknown, event: string, fn: (value: unknown) => void): boolean {
  if (!provider || (typeof provider !== "object" && typeof provider !== "function")) return false;
  try {
    const on = readMember(provider, "on");
    if (typeof on !== "function") return false;
    on.call(provider, event, fn);
    return true;
  } catch {
    return false;
  }
}
