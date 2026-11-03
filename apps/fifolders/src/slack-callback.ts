/** /slack/callback/: the Connect Slack popup (PKCE start + code exchange live in fiperson/notify). */
import { handleSlackCallback } from "fiperson/notify";

const status = document.querySelector<HTMLElement>("#slack-status")!;
void handleSlackCallback()
  .then((r) => {
    status.textContent = r.message;
    if (r.ok && !new URL(location.href).searchParams.has("start")) {
      history.replaceState(null, "", location.pathname); // drop the code from the URL
      if (window.opener) setTimeout(() => window.close(), 600);
    }
  })
  .catch((e) => (status.textContent = `Slack sign-in failed: ${(e as Error).message}`));
