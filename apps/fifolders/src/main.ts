import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "material-symbols/outlined.css";
import { DriveApp, type DriveAppOptions } from "./drive-app.js";
import { readNetworkPreference } from "./network.js";
import { prepareOnboarding, resumeOnboarding } from "./onboarding-controller.js";
import { felBases, openMockSession, storedVolumeName, type Session } from "./session.js";
import { watchSystemTheme } from "./theme.js";
import "./styles.css";

watchSystemTheme((theme) => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
});

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

const app = new DriveApp({
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

const onboard = new URLSearchParams(location.search).get("onboard") === "1";
if (import.meta.env.VITE_E2E === "1" && !onboard) {
  const session = await openMockSession();
  app.attach(optionsFrom(session, app));
} else {
  const io = onboard
    ? (await import("./mock-onboarding.js")).createMockOnboarding(new URLSearchParams(location.search))
    : (await import("./live-onboarding.js")).createLiveOnboarding();
  await prepareOnboarding(app, io);
  try {
    await resumeOnboarding(app, io);
  } catch (error) {
    app.connectError = error instanceof Error ? error.message : "Could not resume the wallet session.";
  }
}

app.mount(root);
