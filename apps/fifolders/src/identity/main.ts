import "../stale-chunks.js";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "./identity.css";
import { IdentityPage } from "./page.js";

const root = document.querySelector<HTMLElement>("#identity-app");
if (!root) throw new Error("missing #identity-app");

async function boot(): Promise<void> {
  const io =
    import.meta.env.VITE_E2E === "1"
      ? (await import("./mock-io.js")).createMockIdentityIO()
      : (await import("./live-io.js")).createLiveIdentityIO();
  await new IdentityPage(root!, io).start();
}

void boot().catch((error) => {
  console.error("identity boot", error);
  root.textContent = "The identity page could not start. Reload to try again.";
});
