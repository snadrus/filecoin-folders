import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "material-symbols/outlined.css";
import { DriveApp, type DriveAppOptions } from "./drive-app.js";
import { readNetworkPreference } from "./network.js";
import { prepareOnboarding, resumeOnboarding } from "./onboarding-controller.js";
import { felBases, openMockSession, storedVolumeName, type Session } from "./session.js";
import { applyTheme } from "./theme.js";
import "./styles.css";

applyTheme();

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("missing #app");

const bases = felBases();

function optionsFrom(session: Session, previous: DriveApp): DriveAppOptions {
  return {
    volume: session.volume,
    owner: session.owner,
    chain: session.chain,
    encrypted: session.encrypted,
    volumeName: session.volumeName,
    cas: session.cas,
    felarumiUrl: previous.felarumiUrl,
    felanumioUrl: previous.felanumioUrl,
    encryptPref: session.encrypted,
    onConnect: previous.onConnect,
    onDisconnect: previous.onDisconnect,
  };
}

function bootMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

let app: DriveApp;
try {
  app = new DriveApp({
    volume: null,
    owner: "",
    chain: readNetworkPreference(),
    encrypted: false,
    volumeName: storedVolumeName(),
    cas: { takeMerged: () => false },
    felarumiUrl: bases.felarumi,
    felanumioUrl: bases.felanumio,
    encryptPref: false,
  });
} catch (error) {
  // A corrupt cached preference must never blank the page: drop FiFolders keys and start clean.
  console.error("FiFolders boot", error);
  for (const key of Object.keys(localStorage)) if (key.startsWith("fifolders:") && !key.includes("session")) localStorage.removeItem(key);
  app = new DriveApp({
    volume: null,
    owner: "",
    chain: "calibration",
    encrypted: false,
    volumeName: "default",
    cas: { takeMerged: () => false },
    felarumiUrl: bases.felarumi,
    felanumioUrl: bases.felanumio,
    encryptPref: false,
  });
}

// Mount first so the UI is always visible; resume runs behind it and may show the renew banner.
app.mount(root);
window.addEventListener("error", (event) => app.showBootError(bootMessage(event.error, "Something went wrong.")));
window.addEventListener("unhandledrejection", (event) => app.showBootError(bootMessage(event.reason, "Something went wrong.")));

async function boot(): Promise<void> {
  const onboard = new URLSearchParams(location.search).get("onboard") === "1";
  if (import.meta.env.VITE_E2E === "1" && !onboard) {
    const session = await openMockSession();
    app.attach(optionsFrom(session, app));
    return;
  }
  const io = onboard
    ? (await import("./mock-onboarding.js")).createMockOnboarding(new URLSearchParams(location.search))
    : (await import("./live-onboarding.js")).createLiveOnboarding();
  await prepareOnboarding(app, io);
  try {
    await resumeOnboarding(app, io);
  } catch (error) {
    app.showBootError(bootMessage(error, "Could not resume the wallet session."));
  }
}

void boot().catch((error) => app.showBootError(bootMessage(error, "FiFolders could not start.")));
