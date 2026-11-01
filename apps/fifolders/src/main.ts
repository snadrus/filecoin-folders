import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "material-symbols/outlined.css";
import { DriveApp, type DriveAppOptions } from "./drive-app.js";
import {
  connectInjected,
  felBases,
  openMockSession,
  storeEncrypt,
  storeVolumeName,
  storedVolumeName,
  type Session,
} from "./session.js";
import "./styles.css";

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
  chain: "calibration",
  encrypted: false,
  volumeName: storedVolumeName(),
  cas: { takeMerged: () => false },
  felarumiUrl: bases.felarumi,
  felanumioUrl: bases.felanumio,
  encryptPref: false,
  onConnect: async (input) => {
    const ethereum = window.ethereum;
    if (!ethereum) throw new Error("No injected wallet found. Install a browser wallet such as MetaMask.");
    const session = await connectInjected({ ethereum, ...input });
    storeVolumeName(session.volumeName);
    storeEncrypt(session.chain, session.owner, session.volumeName, session.encrypted);
    app.attach(optionsFrom(session, app));
  },
  onDisconnect() {
    localStorage.removeItem("fifolders:volume-name");
  },
});

if (import.meta.env.VITE_E2E === "1") {
  const session = await openMockSession();
  app.attach(optionsFrom(session, app));
}

app.mount(root);
