import "../stale-chunks.js";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "./treclub.css";
import { getAddress } from "viem";
import { ClubPage } from "./page.js";

const root = document.querySelector<HTMLElement>("#treclub-app");
if (!root) throw new Error("missing #treclub-app");

async function boot(): Promise<void> {
  const env = import.meta.env;
  // Calibration deployment (deployments/treclub-calibration.json); env overrides. E2E mock runs ignore it.
  const CALIBRATION_TRECLUB = "0x412B9363019591588073B3489CB09d28d2a55A03";
  const address = env.VITE_TRECLUB_ADDRESS_LOCAL || env.VITE_TRECLUB_ADDRESS_CALIBRATION || (env.VITE_E2E === "1" ? "" : CALIBRATION_TRECLUB);
  if (!address) {
    const { createMockClubIO } = await import("./mock-io.js");
    await new ClubPage(root!, createMockClubIO()).start();
    return;
  }
  const { createLiveClubIO } = await import("./live-io.js");
  const local = !!env.VITE_TRECLUB_RPC;
  const io = createLiveClubIO(getAddress(address), env.VITE_TRECLUB_RPC || undefined, env.VITE_TRECLUB_CHAIN_ID ? Number(env.VITE_TRECLUB_CHAIN_ID) : undefined);
  const resolve = local || env.VITE_E2E === "1" ? undefined : (await import("../person.js")).resolvePerson;
  await new ClubPage(root!, io, { resolve: resolve ? (a) => resolve(a, "calibration") : undefined }).start();
}

void boot().catch((error) => {
  console.error("treclub boot", error);
  root.textContent = "TreClub could not start. Reload to try again.";
});
