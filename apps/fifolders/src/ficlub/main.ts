import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "./ficlub.css";
import { getAddress } from "viem";
import { ClubPage } from "./page.js";

const root = document.querySelector<HTMLElement>("#ficlub-app");
if (!root) throw new Error("missing #ficlub-app");

async function boot(): Promise<void> {
  const env = import.meta.env;
  // Calibration deployment (deployments/ficlub-calibration.json); env overrides. E2E mock runs ignore it.
  const CALIBRATION_FICLUB = "0x4f73E1504d848eC4e3e74047940bD97EA79A3521";
  const address = env.VITE_FICLUB_ADDRESS_LOCAL || env.VITE_FICLUB_ADDRESS_CALIBRATION || (env.VITE_E2E === "1" ? "" : CALIBRATION_FICLUB);
  if (!address) {
    const { createMockClubIO } = await import("./mock-io.js");
    await new ClubPage(root!, createMockClubIO()).start();
    return;
  }
  const { createLiveClubIO } = await import("./live-io.js");
  const local = !!env.VITE_FICLUB_RPC;
  const io = createLiveClubIO(getAddress(address), env.VITE_FICLUB_RPC || undefined, env.VITE_FICLUB_CHAIN_ID ? Number(env.VITE_FICLUB_CHAIN_ID) : undefined);
  const resolve = local || env.VITE_E2E === "1" ? undefined : (await import("../person.js")).resolvePerson;
  await new ClubPage(root!, io, { resolve: resolve ? (a) => resolve(a, "calibration") : undefined }).start();
}

void boot().catch((error) => {
  console.error("ficlub boot", error);
  root.textContent = "FiClub could not start. Reload to try again.";
});
