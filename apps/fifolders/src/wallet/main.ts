import { runLimitedWalletFrame } from "@fifolders/sponsored-client";
import "./wallet.css";

const root = document.getElementById("wallet-app")!;
const role = new URLSearchParams(location.search).get("role");
if (role !== "iframe") document.documentElement.classList.add("standalone");

type ConfirmInput = { origin: string; action: string; method: string };

function render(html: string) {
  root.innerHTML = html;
}

function idle(title: string, body: string) {
  render(
    `<div class="backdrop idle" data-testid="wallet-idle"><div class="card">
      <p class="brand"><strong>FiFolders</strong> limited wallet</p>
      <h1>${title}</h1>
      <p class="note">${body}</p>
    </div></div>`,
  );
}

function confirmView(input: ConfirmInput): Promise<boolean> {
  return new Promise((resolve) => {
    render(
      `<div class="backdrop" data-testid="wallet-confirm">
        <div class="card" role="dialog" aria-labelledby="wallet-title">
          <p class="brand"><strong>FiFolders</strong> limited wallet</p>
          <h1 id="wallet-title">Confirm this request</h1>
          <p><span data-testid="wallet-origin-label">${escapeHtml(input.origin)}</span> wants to ${escapeHtml(input.action)}.</p>
          <span class="origin" data-testid="wallet-origin">${escapeHtml(input.origin)}</span>
          <p class="note">Signatures are accepted by your locked account from any site, so only continue if you trust this app and meant to open it.</p>
          <p class="error" data-testid="wallet-error" hidden></p>
          <div class="actions">
            <button type="button" class="ghost" data-action="cancel" data-testid="wallet-cancel">Cancel</button>
            <button type="button" class="primary" data-action="continue" data-testid="wallet-continue">Continue</button>
          </div>
        </div>
      </div>`,
    );
    const settle = (ok: boolean) => {
      root.onclick = null;
      resolve(ok);
    };
    root.onclick = (event) => {
      const action = (event.target as HTMLElement | null)?.closest("[data-action]")?.getAttribute("data-action");
      if (action === "continue") settle(true);
      if (action === "cancel") settle(false);
      if (event.target === root.querySelector(".backdrop")) settle(false);
    };
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function setBusy(busy: boolean) {
  const continueBtn = root.querySelector<HTMLButtonElement>("[data-action=continue]");
  const cancelBtn = root.querySelector<HTMLButtonElement>("[data-action=cancel]");
  if (continueBtn) {
    continueBtn.disabled = busy;
    continueBtn.textContent = busy ? "Waiting for your passkey…" : "Continue";
  }
  if (cancelBtn) cancelBtn.disabled = busy;
}

runLimitedWalletFrame({
  confirm: confirmView,
  busy: setBusy,
  standalone() {
    idle(
      "This is the FiFolders limited wallet",
      "Apps use this page in a frame or a small window so you can create or use a passkey that only this wallet can spend. Open it from an app to sign in. There is nothing to do here on its own.",
    );
  },
});

if (role === "iframe" || role === "popup") {
  idle("Waiting for the app…", "This window will ask you to confirm before any passkey prompt appears.");
}
