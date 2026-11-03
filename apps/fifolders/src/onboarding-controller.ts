import type { ChainReport } from "./chain-step.js";
import type { DriveApp } from "./drive-app.js";
import { canEnter, isSessionPermissionError, type WalletPanel } from "./onboarding-logic.js";
import type { OnboardingIO } from "./onboarding-io.js";
import { INTENTS, withWalletIntent } from "./wallet-prompts.js";
import { storeEncrypt, storeVolumeName, type ChainChoice, type Session } from "./session.js";

export async function prepareOnboarding(app: DriveApp, io: OnboardingIO): Promise<void> {
  try {
    app.setWallets(await io.discover());
  } catch {
    app.setWallets([]);
  }
  app.onConnect = async (input) => {
    await io.connect({ rdns: app.walletRdns || null, chain: input.chain });
    void peekDrive(app, io, input.encrypt);
    await continueOnboarding(app, io, input, true);
  };
  app.onPickDataset = (id) => io.selectDataset(id, app.chain);
  app.onSetupAction = async (action, value) => {
    const chain = app.chain;
    const volumeName = app.volumeName;
    const encrypt = app.encryptPref;
    const report = (step: ChainReport) => app.noteChain(step);
    if (action === "authorize" || action === "refresh-session") await io.authorize(chain, action === "refresh-session", report);
    else if (action === "fix-payments") {
      await io.fixPayments(chain, report, false);
      await continueOnboarding(app, io, { chain, volumeName, encrypt }, true);
      return;
    }
    else if (action === "add-funds") {
      await io.fixPayments(chain, report, true);
      app.showPanel(await io.snapshot({ chain, volumeName }));
      return;
    }
    else if (action === "create-dataset") {
      const op = app.beginOp({ kind: "dataset", label: "Create dataset", stage: "pending" });
      try {
        await app.ensureSession();
        try {
          await withWalletIntent(INTENTS.createDataset, () => io.createDataset({ chain, volumeName }));
        } catch (error) {
          if (!isSessionPermissionError(error)) throw error;
          await app.waitForRenewal();
          await withWalletIntent(INTENTS.createDataset, () => io.createDataset({ chain, volumeName }));
        }
        app.finishOp(op);
      } catch (error) {
        console.error("FiFolders dataset", error);
        const message = isSessionPermissionError(error)
          ? "Session expired — Renew (1 signature)"
          : error instanceof Error
            ? error.message
            : "Dataset was not created.";
        app.failOp(op, message);
        throw error;
      }
    }
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
    if (app.volume && !app.readOnly) {
      app.showPanel(panel);
      return;
    }
    if (canEnter(panel) && action !== "select-dataset") await openDrive(app, io, { chain, volumeName, encrypt });
    else app.showPanel(panel);
  };
  app.onDisconnect = () => {
    io.disconnect();
    app.detachToConnect();
  };
  app.onEnsureSession = () => io.sessionGate(app.chain);
  app.onRenewSession = async () => {
    await io.authorize(app.chain, true, (step) => app.noteChain(step));
    if (app.volume) {
      const session = await io.reopen({ chain: app.chain, volumeName: app.volumeName, encrypt: app.encrypted });
      if (session) app.replaceVolume(session.volume, session.cas);
    }
    app.showPanel(await io.snapshot({ chain: app.chain, volumeName: app.volumeName }));
  };
}

/**
 * Folders are public: show the preferred dataset's drive read-only with no signature,
 * while payment approval and session authorization finish behind it.
 */
export async function peekDrive(app: DriveApp, io: OnboardingIO, encrypt = app.encryptPref): Promise<boolean> {
  if (!io.peek || app.volume || encrypt) return false;
  try {
    const session = await io.peek({ chain: app.chain, volumeName: app.volumeName });
    if (!session || app.volume) return false;
    app.attachReadOnly({
      volume: session.volume,
      owner: session.owner,
      chain: session.chain,
      encrypted: false,
      volumeName: session.volumeName,
      cas: session.cas,
      felarumiUrl: app.felarumiUrl,
      felanumioUrl: app.felanumioUrl,
      ...(app.panel ? { panel: app.panel } : {}),
    });
    return true;
  } catch (error) {
    console.warn("FiFolders public read", error);
    return false;
  }
}

/** Reload path. No `eth_requestAccounts` and no signature when the session key is still valid. */
export async function resumeOnboarding(app: DriveApp, io: OnboardingIO): Promise<boolean> {
  const chain = app.chain;
  const peeked = peekDrive(app, io);
  const found = await io.silent(chain);
  if (!found) return false;
  const panel = await io.snapshot({ chain, volumeName: app.volumeName });
  if (!panel.sessionReady) {
    // Browsing the public drive: name the next wallet step instead of the connect screen.
    if ((await peeked) || app.readOnly) app.showPanel(panel);
    return false;
  }
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
  // Storage payment comes first: show "Enable storage payment" before any upload can fail on it.
  if (!panel.paymentsReady) {
    app.showPanel(panel);
    return;
  }
  if (autoAuthorize && !panel.sessionReady) {
    try {
      await io.authorize(input.chain, false, (step) => app.noteChain(step));
      panel = await io.snapshot(input);
    } catch (error) {
      console.error("FiFolders authorize", error);
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
  if (!app.panel) {
    try {
      app.showPanel(await io.snapshot(input));
    } catch {
      // The connect screen still hosts the renew banner if the snapshot cannot be read.
    }
  }
  let session: Session;
  try {
    await app.ensureSession();
    session = await io.enter(input);
  } catch (error) {
    if (!isSessionPermissionError(error)) throw error;
    await app.waitForRenewal();
    session = await io.enter(input);
  }
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
