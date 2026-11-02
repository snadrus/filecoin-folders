import type { DriveApp } from "./drive-app.js";
import { canEnter, type WalletPanel } from "./onboarding-logic.js";
import type { OnboardingIO } from "./onboarding-io.js";
import { storeEncrypt, storeVolumeName, type ChainChoice, type Session } from "./session.js";

export async function prepareOnboarding(app: DriveApp, io: OnboardingIO): Promise<void> {
  try {
    app.setWallets(await io.discover());
  } catch {
    app.setWallets([]);
  }
  app.onConnect = async (input) => {
    await io.connect({ rdns: app.walletRdns || null, chain: input.chain });
    await continueOnboarding(app, io, input, true);
  };
  app.onSetupAction = async (action, value) => {
    const chain = app.chain;
    const volumeName = app.volumeName;
    const encrypt = app.encryptPref;
    if (action === "authorize" || action === "refresh-session") await io.authorize(chain, action === "refresh-session");
    else if (action === "fix-payments") await io.fixPayments(chain);
    else if (action === "create-dataset") await io.createDataset({ chain, volumeName });
    else if (action === "select-dataset" && value) {
      io.selectDataset(value, chain);
      const picked = await io.snapshot({ chain, volumeName });
      if (canEnter(picked)) await openDrive(app, io, { chain, volumeName, encrypt });
      else app.showPanel(picked);
      return;
    } else if (action === "open-drive") {
      await openDrive(app, io, { chain, volumeName, encrypt });
      return;
    }
    const panel = await io.snapshot({ chain, volumeName });
    if (canEnter(panel) && action !== "select-dataset") await openDrive(app, io, { chain, volumeName, encrypt });
    else app.showPanel(panel);
  };
  app.onDisconnect = () => {
    io.disconnect();
    app.detachToConnect();
  };
}

/** Reload path. No `eth_requestAccounts` and no signature when the session key is still valid. */
export async function resumeOnboarding(app: DriveApp, io: OnboardingIO): Promise<boolean> {
  const chain = app.chain;
  const found = await io.silent(chain);
  if (!found) return false;
  const panel = await io.snapshot({ chain, volumeName: app.volumeName });
  if (!panel.sessionReady && !panel.legacyRegistry) return false;
  if (!canEnter(panel)) {
    app.showPanel(panel);
    return true;
  }
  await openDrive(app, io, { chain, volumeName: app.volumeName, encrypt: app.encryptPref });
  return true;
}

async function continueOnboarding(
  app: DriveApp,
  io: OnboardingIO,
  input: { chain: ChainChoice; volumeName: string; encrypt: boolean },
  autoAuthorize: boolean,
): Promise<void> {
  let panel = await io.snapshot(input);
  if (autoAuthorize && !panel.sessionReady && !panel.legacyRegistry) {
    try {
      await io.authorize(input.chain);
      panel = await io.snapshot(input);
    } catch (error) {
      app.showPanel(panel, error instanceof Error ? error.message : "The session key was not authorized.");
      return;
    }
  }
  if (canEnter(panel)) await openDrive(app, io, input);
  else app.showPanel(await io.snapshot(input));
}

async function openDrive(
  app: DriveApp,
  io: OnboardingIO,
  input: { chain: ChainChoice; volumeName: string; encrypt: boolean },
): Promise<void> {
  const session = await io.enter(input);
  storeVolumeName(session.volumeName);
  storeEncrypt(session.chain, session.owner, session.volumeName, session.encrypted);
  const panel = await io.snapshot(input);
  app.attach(sessionToOptions(app, session, panel));
}

function sessionToOptions(app: DriveApp, session: Session, panel: WalletPanel) {
  return {
    volume: session.volume,
    owner: session.owner,
    chain: session.chain,
    encrypted: session.encrypted,
    volumeName: session.volumeName,
    cas: session.cas,
    felarumiUrl: app.felarumiUrl,
    felanumioUrl: app.felanumioUrl,
    encryptPref: session.encrypted,
    panel,
    onConnect: app.onConnect,
    onSetupAction: app.onSetupAction,
    onDisconnect: app.onDisconnect,
  };
}
