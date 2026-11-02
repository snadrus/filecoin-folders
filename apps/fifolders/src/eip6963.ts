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
    const uuid = detail?.info?.uuid;
    const provider = detail?.provider;
    if (!uuid || !provider?.request) return;
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
      const ethereum = window.ethereum;
      if (ethereum?.request && !list.some((wallet) => wallet.provider === ethereum)) {
        list.push({ uuid: LEGACY_UUID, name: "Browser wallet", rdns: "window.ethereum", provider: ethereum });
      }
      resolve(list);
    }, timeoutMs);
  });
}
