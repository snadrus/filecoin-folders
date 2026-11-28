import { connectLimitedWallet, type LimitedWalletClient } from "@trefolders/sponsored-client";

const params = new URLSearchParams(location.search);
const walletUrl = params.get("wallet") || "http://localhost:4177/wallet/";
const preferPopup = params.get("popup") === "1";
const out = document.getElementById("out")!;
const openPopup = document.getElementById("open-popup") as HTMLButtonElement;
document.getElementById("origin")!.textContent = location.origin;

const client: LimitedWalletClient = connectLimitedWallet({
  walletUrl,
  preferPopup,
  onPopupBlocked: (retry) => {
    openPopup.hidden = false;
    openPopup.onclick = () => {
      openPopup.hidden = true;
      retry();
    };
  },
});

function show(value: unknown) {
  out.textContent = typeof value === "string" ? value : JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

async function run(fn: () => Promise<unknown>) {
  try {
    show(await fn());
  } catch (error) {
    out.textContent = `ERROR ${(error as Error).name || ""}: ${(error as Error).message || error}`;
  }
}

document.getElementById("create")!.onclick = () => run(() => client.create("E2E user"));
document.getElementById("assert")!.onclick = () => {
  const last = JSON.parse(out.textContent || "null") as { credentialId?: string } | null;
  const id = last?.credentialId;
  if (!id) {
    out.textContent = "ERROR: create a passkey first";
    return;
  }
  const challenge = "0x" + "ab".repeat(32);
  return run(() => client.assert(id, challenge as `0x${string}`));
};
document.getElementById("discover")!.onclick = () =>
  run(() => client.discover(crypto.getRandomValues(new Uint8Array(32))));
