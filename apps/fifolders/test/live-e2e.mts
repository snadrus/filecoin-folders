// Live e2e: Pages + Calibration Worker, virtual passkey, Stripe 4242, v2 handover, drive/identity/fipen/person.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";
import { payOnPage } from "./support/stripe-pay.js";

const OUT = "/workspace/fil-gasless/live";
const SITE = "https://fifolders.scionbase.ai";
const PURCHASE_USD = 3.91;
const CRED_FILE = `${OUT}/webauthn.credential.json`;
const RESUME = process.env.LIVE_E2E_RESUME === "1" || process.argv.includes("--resume");
const WORKER = "https://fast.scionbase.ai";
const RPC = "https://api.calibration.node.glif.io/rpc/v1";
const FACTORY = "0x228867301f1f0EaF75b5d7af62F3c44e1796A56D";
const LEGACY = "0xCBb99E41C173B06D15212A135ba9F46AAB19DEE5";
const log: Record<string, unknown> = { started: new Date().toISOString(), steps: {} as Record<string, unknown> };
const steps = log.steps as Record<string, unknown>;

const flush = () => writeFileSync(`${OUT}/result.json`, JSON.stringify(log, null, 2));
const say = (msg: string) => {
  console.log(`[e2e ${new Date().toISOString()}] ${msg}`);
  log.last = msg;
  flush();
};

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});

const executeBodies: unknown[] = [];
const sponsorPaths: string[] = [];
page.on("request", (r) => {
  if (r.url().startsWith(WORKER)) sponsorPaths.push(`${r.method()} ${new URL(r.url()).pathname}`);
});
page.on("response", async (r) => {
  if (!r.url().startsWith(WORKER)) return;
  if (r.url().includes("/execute")) {
    const body = await r.json().catch(() => null);
    if (body) executeBodies.push(body);
  }
});
page.on("console", (m) => {
  if (m.type() === "error") console.log("console:", m.text().slice(0, 240));
});

let shot = 0;
const snap = async (p: Page, name: string) => {
  const file = `${OUT}/${String(++shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: file, fullPage: true });
  say(`screenshot ${file}`);
  return file;
};
const textOf = async (p: Page) => (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 800);
const visible = async (p: Page, testId: string) => p.getByTestId(testId).first().isVisible().catch(() => false);

async function clickIf(p: Page, testId: string) {
  if (await visible(p, testId)) {
    await p.getByTestId(testId).first().click();
    return true;
  }
  return false;
}

let lastPasskeyClick = 0;
async function loadSavedPasskey(authenticatorId: string, cdp: { send: (method: never, params?: never) => Promise<unknown> }) {
  if (!existsSync(CRED_FILE)) return 0;
  const saved = JSON.parse(readFileSync(CRED_FILE, "utf8")) as { rpId?: string; credentials?: Array<Record<string, unknown>> };
  const list = saved.credentials ?? [];
  for (const credential of list) {
    await cdp.send(...(["WebAuthn.addCredential", {
      authenticatorId,
      credential: { ...credential, rpId: credential.rpId || saved.rpId || "fifolders.scionbase.ai" },
    }] as [never, never]));
  }
  return list.length;
}

async function continuePasskey(p: Page, preferExisting = false) {
  if (Date.now() - lastPasskeyClick < 8_000) return null;
  const kind = preferExisting
    ? ((await clickIf(p, "passkey-existing")) ? "existing" : (await clickIf(p, "passkey-continue")) ? "continue" : null)
    : ((await clickIf(p, "passkey-continue")) ? "continue" : (await clickIf(p, "passkey-existing")) ? "existing" : null);
  if (kind) lastPasskeyClick = Date.now();
  return kind;
}

/** Background /credits poll so worker-ready is measured even if the UI is still on the passkey screen. */
function startCreditPoll(sessionId: string, rec: Record<string, unknown>, since: { submit?: number; return?: number }) {
  if (!sessionId) return () => undefined;
  let stop = false;
  let last = "";
  void (async () => {
    while (!stop) {
      try {
        const res = await fetch(`${WORKER}/credits?session=${encodeURIComponent(sessionId)}`, { headers: { "user-agent": "Mozilla/5.0" } });
        const body = (await res.json()) as Record<string, unknown>;
        const stamp = `${body.status}:${body.account ?? ""}:${body.finality ?? ""}`;
        if (stamp !== last) {
          last = stamp;
          const acct = typeof body.account === "string" ? `${body.account.slice(0, 6)}…` : "none";
          say(`credits poll status=${body.status} finality=${body.finality ?? "none"} account=${acct}`);
          if (body.status === "pending" && !rec.tWorkerPending) {
            rec.tWorkerPending = new Date().toISOString();
            if (since.submit) rec.secSubmitToPending = Math.round((Date.now() - since.submit) / 1000);
          }
          if (body.account && (body.status === "done" || body.status === "included") && !rec.tWorkerReady) {
            rec.tWorkerReady = new Date().toISOString();
            rec.creditTiming = body.timing ?? null;
            rec.creditInclusion = body.inclusion ?? null;
            rec.paidAt = body.paidAt ?? null;
            if (since.submit) rec.secSubmitToWorkerReady = Math.round((Date.now() - since.submit) / 1000);
            if (since.return) rec.secReturnToWorkerReady = Math.round((Date.now() - since.return) / 1000);
            say(`worker marked ready after submit ${rec.secSubmitToWorkerReady ?? "?"}s return ${rec.secReturnToWorkerReady ?? "?"}s`);
          }
        }
      } catch {
        /* ignore transient poll errors */
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  })();
  return () => {
    stop = true;
  };
}

async function ethCall(to: string, data: string) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const json = (await res.json()) as { result?: string; error?: { message?: string } };
  if (!json.result) throw new Error(json.error?.message || "eth_call failed");
  return json.result;
}

async function isAccount(factory: string, account: string) {
  const data = "0x25ca4c9c" + account.slice(2).toLowerCase().padStart(64, "0");
  const result = await ethCall(factory, data);
  return BigInt(result) === 1n;
}

async function waitUntil(ms: number, label: string, fn: () => Promise<boolean>, intervalMs = 2_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await page.waitForTimeout(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

let stopCreditPoll: () => void = () => undefined;
try {
  // Load prior run BEFORE any say()/flush so resume does not clobber result.json
  // with a fresh volume name. Prefer LIVE_E2E_PREV, then after-timing.json (the
  // timing rerun), then result.json, then the frozen baseline.json.
  let volumeName = `live-e2e-${Date.now().toString(36)}`;
  let session = "";
  let tPayment = 0;
  let tHandover = Date.now();
  if (RESUME) {
    try {
      const prevPath = [
        process.env.LIVE_E2E_PREV,
        `${OUT}/after-timing.json`,
        `${OUT}/result.json`,
        `${OUT}/baseline.json`,
      ].find((p) => !!p && existsSync(p));
      if (prevPath) {
        const prev = JSON.parse(readFileSync(prevPath, "utf8")) as Record<string, unknown>;
        if (typeof prev.volumeName === "string") volumeName = prev.volumeName;
        if (typeof prev.tPayment === "string") {
          log.tPayment = prev.tPayment;
          tPayment = Date.parse(prev.tPayment);
        }
        if (prev.tSessionReady) log.tSessionReady = prev.tSessionReady;
        if (prev.tFirstSave) log.tFirstSave = prev.tFirstSave;
        if (prev.secPaymentToPaymentsReady != null) log.secPaymentToPaymentsReady = prev.secPaymentToPaymentsReady;
        if (prev.secPaymentToSessionReady != null) log.secPaymentToSessionReady = prev.secPaymentToSessionReady;
        if (prev.secSessionToFirstSave != null) log.secSessionToFirstSave = prev.secSessionToFirstSave;
        if (prev.secPaymentToFirstSave != null) log.secPaymentToFirstSave = prev.secPaymentToFirstSave;
        if (prev.tPaymentsReady) log.tPaymentsReady = prev.tPaymentsReady;
        if (prev.account) log.account = prev.account;
        if (prev.steps && typeof prev.steps === "object") Object.assign(steps, prev.steps);
        log.volumeName = volumeName;
        log.priorPath = prevPath;
      }
    } catch {
      /* no prior result */
    }
  }

  // --- 1 already confirmed at start; record status ---
  const status0 = await (await fetch(WORKER + "/status", { headers: { "user-agent": "Mozilla/5.0" } })).json();
  steps.poolBefore = {
    funds: status0.funds,
    pool: status0.pool,
    checkoutOpen: status0.checkoutOpen,
    gasKilled: status0.gas?.killed,
  };
  say(`status funds=${status0.funds?.level} ready=${status0.pool?.ready} fil=${status0.funds?.fil} usdfc=${status0.funds?.usdfc}`);

  if (RESUME) {
    const n = await loadSavedPasskey(authenticatorId, cdp);
    if (!n) throw new Error("resume requested but no saved passkey at CRED_FILE");
    log.resumed = true;
    log.volumeName = volumeName;
    say(`resume: loaded ${n} passkey(s); skipping checkout to reuse the same account`);
    await page.goto(SITE, { waitUntil: "networkidle" });
    await page.getByTestId("chain-calibration").click().catch(() => undefined);
    await snap(page, "resume-start");
    const signed = (await continuePasskey(page)) || (await clickIf(page, "passkey-existing") ? "existing" : (await clickIf(page, "passkey-continue") ? "continue" : null));
    if (signed) say(`resume clicked passkey ${signed}`);
    await waitUntil(3 * 60_000, "signed in on resume", async () => {
      if (await visible(page, "account") || await visible(page, "payment-status") || await visible(page, "credit-balance") || await visible(page, "add-credits")) return true;
      await continuePasskey(page);
      return false;
    });
    if (!tPayment) {
      tPayment = Date.now();
      log.tPayment = new Date(tPayment).toISOString();
    }
    await snap(page, "resume-signed-in");
  }

  if (!RESUME) {
  log.volumeName = volumeName;

  await page.goto(`${SITE}/?usd=${PURCHASE_USD}`, { waitUntil: "networkidle" });
  await page.getByTestId("chain-calibration").click().catch(() => undefined);
  await page.getByTestId("volume-name").fill(volumeName).catch(() => undefined);
  await snap(page, "start");
  await page.getByTestId("passkey-new").click();
  await page.getByTestId("fix-payments").first().waitFor({ timeout: 90_000 });
  await snap(page, "signed-in");
  steps.signIn = { ok: true, text: await textOf(page) };
  const creds = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  writeFileSync(CRED_FILE, JSON.stringify({ authenticatorId, rpId: "fifolders.scionbase.ai", credentials: creds.credentials }));
  chmodSync(CRED_FILE, 0o600);
  const passkeyMeta = { count: creds.credentials.length, discoverable: creds.credentials.every((c) => c.isResidentCredential) };
  log.passkey = passkeyMeta;
  say(`signed in, ${passkeyMeta.count} passkey(s); credential saved`);

  await Promise.all([
    page.waitForURL(/checkout\.stripe\.com/, { timeout: 90_000 }),
    page.getByTestId("fix-payments").first().click(),
  ]);
  const checkoutTest = /cs_test_/.test(page.url());
  session = /cs_test_[A-Za-z0-9]+/.exec(page.url())?.[0] ?? "";
  steps.checkout = { testMode: checkoutTest, session: session ? "cs_test_…" : "" };
  if (!checkoutTest) throw new Error("checkout was not Stripe test mode");
  say("on Stripe test checkout");
  log.tCheckoutPage = new Date().toISOString();
  const creditSince: { submit?: number; return?: number } = {};
  stopCreditPoll = startCreditPoll(session, log, creditSince);
  await payOnPage(page, {
    email: "fifolders-live-e2e@example.com",
    screenshot: `${OUT}/stripe-fail.png`,
    onSubmit: () => {
      creditSince.submit = Date.now();
      log.tCheckoutSubmit = new Date(creditSince.submit).toISOString();
      say("Stripe checkout submitted");
    },
  });
  await page.waitForURL(/fifolders\.scionbase\.ai/, { timeout: 150_000 });
  log.returnedTo = page.url().replace(/session_id=[^&]+/, "session_id=…");
  tPayment = Date.now();
  creditSince.return = tPayment;
  log.tPayment = new Date(tPayment).toISOString();
  if (creditSince.submit) log.secSubmitToReturn = Math.round((tPayment - creditSince.submit) / 1000);
  await snap(page, "after-stripe");
  say(`returned from Stripe: ${log.returnedTo}`);

  tHandover = Date.now();
  let lastMark = 0;
  let reloaded = false;
  const paymentsReady = async () =>
    (await visible(page, "payment-status")) || (await visible(page, "credit-balance")) || (await visible(page, "add-credits"));
  await waitUntil(12 * 60_000, "payments ready after passkey resume", async () => {
    if (await paymentsReady()) {
      if (!log.tPasskeyIn) {
        log.tPasskeyIn = new Date().toISOString();
        say(`passkey accepted ${Math.round((Date.now() - tPayment) / 1000)}s after return`);
      }
      return true;
    }
    const clicked = await continuePasskey(page, true);
    if (clicked) say(`clicked passkey ${clicked} after redirect`);
    if (!log.tPasskeyIn && ((await visible(page, "account") || await visible(page, "setup-address")) && !(await visible(page, "passkey-continue") || await visible(page, "passkey-existing")))) {
      log.tPasskeyIn = new Date().toISOString();
      say(`passkey accepted ${Math.round((Date.now() - tPayment) / 1000)}s after return`);
    }
    if (await paymentsReady()) return true;
    // Gasless setup uses credit-balance/add-credits; open the account menu if we are signed in but the setup card is hidden.
    if ((await visible(page, "account")) && !(await visible(page, "setup-address")) && !(await paymentsReady())) {
      await page.getByTestId("account").click().catch(() => undefined);
    }
    const elapsed = Date.now() - tHandover;
    // After the sponsor has applied the payment, a stale "Buy storage credits" panel is usually the
    // checkout-settle race; reload and continue with the saved passkey.
    if (!reloaded && elapsed > 90_000 && (await visible(page, "fix-payments")) && (await visible(page, "setup-address"))) {
      reloaded = true;
      say("payments still pending in UI; reloading to pick up the assigned account");
      await page.reload({ waitUntil: "networkidle" });
      await continuePasskey(page);
    }
    if (elapsed - lastMark > 20_000) {
      lastMark = elapsed;
      const ids = ["passkey-continue", "passkey-unavailable", "passkey-existing", "fix-payments", "add-credits", "credit-balance", "payment-status", "setup-address", "authorize-session", "create-dataset", "file-input", "drive-pending", "setup"];
      const seen: string[] = [];
      for (const id of ids) if (await visible(page, id)) seen.push(id);
      say(`handover wait ${Math.round(elapsed / 1000)}s visible=${seen.join(",") || "none"} text=${(await textOf(page)).slice(0, 180)}`);
      await snap(page, `handover-${Math.round(elapsed / 1000)}s`);
    }
    return false;
  }, 500);
  const handover = { ok: true, seconds: Math.round((Date.now() - tHandover) / 1000), text: "" };
  await snap(page, "paid-ready");
  handover.text = await textOf(page);
  steps.handover = handover;
  say(`payments ready after ${handover.seconds}s`);
  log.tPaymentsReady = new Date().toISOString();
  log.secPaymentToPaymentsReady = Math.round((Date.now() - tPayment) / 1000);
  const stages: Record<string, unknown> = {
    secSubmitToReturn: log.secSubmitToReturn ?? null,
    secSubmitToPending: log.secSubmitToPending ?? null,
    secSubmitToWorkerReady: log.secSubmitToWorkerReady ?? null,
    secReturnToWorkerReady: log.secReturnToWorkerReady ?? null,
    secReturnToPasskey: log.tPasskeyIn && tPayment ? Math.round((Date.parse(String(log.tPasskeyIn)) - tPayment) / 1000) : null,
    secReturnToUiReady: log.secPaymentToPaymentsReady,
    creditTiming: log.creditTiming ?? null,
  };
  log.stages = stages;
  say(`stage table ${JSON.stringify(stages)}`);
  stopCreditPoll();
  }

  // Finish setup: authorize / open drive. file-input is sr-only and present during setup, so it is not a ready signal.
  let clickedCreate = false;
  let clickedAuth = false;
  let lastAuthClick = 0;
  let lastSetupMark = 0;
  const sessionReady = async () => {
    if (!(await visible(page, "session-status")) && (await visible(page, "account"))) {
      await page.getByTestId("account").click().catch(() => undefined);
    }
    const status = (await page.getByTestId("session-status").innerText().catch(() => "")).trim();
    return /Session key until/i.test(status);
  };
  await waitUntil(20 * 60_000, "drive ready for upload", async () => {
    if (await sessionReady()) return true;
    if (await visible(page, "create-dataset") && !clickedCreate && !(await visible(page, "file-input")) && !(await page.getByText("This folder is empty").count())) {
      clickedCreate = true;
      say("clicking create-dataset");
      await page.getByTestId("create-dataset").first().click();
      return false;
    }
    if (await visible(page, "authorize-session") && Date.now() - lastAuthClick > 60_000) {
      lastAuthClick = Date.now();
      clickedAuth = true;
      say("clicking authorize-session during setup");
      await page.getByTestId("authorize-session").first().click().catch(() => undefined);
      return false;
    }
    if (await visible(page, "open-drive")) {
      say("clicking open-drive");
      await page.getByTestId("open-drive").click().catch(() => undefined);
      await page.waitForTimeout(2000);
      return false;
    }
    await continuePasskey(page);
    const elapsed = Date.now() - tHandover;
    if (elapsed - lastSetupMark > 20_000) {
      lastSetupMark = elapsed;
      say(`setup wait ${Math.round(elapsed / 1000)}s text=${(await textOf(page)).slice(0, 180)}`);
      await snap(page, `setup-${Math.round(elapsed / 1000)}s`);
    }
    return false;
  });

  let credit: Record<string, unknown> = {};
  if (session) {
    credit = (await (await fetch(`${WORKER}/credits?session=${session}`, { headers: { "user-agent": "Mozilla/5.0" } })).json()) as Record<string, unknown>;
  }
  // also try to discover payer from the account menu / setup address
  if (await visible(page, "account")) await page.getByTestId("account").click().catch(() => undefined);
  if (await visible(page, "account") && !(await visible(page, "setup-address")) && !(await visible(page, "session-status"))) {
    await page.getByTestId("account").click().catch(() => undefined);
  }
  const setupAddress = (await page.getByTestId("setup-address").textContent().catch(() => ""))?.trim() || "";
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const handoverText = String((steps.handover as { text?: string } | undefined)?.text ?? "");
  const fromPage = (bodyText + " " + handoverText).match(/0x[a-fA-F0-9]{40}/)?.[0] || "";
  const priorAccount = String((log.credit as { account?: string } | undefined)?.account || (steps.v2Account as { account?: string } | undefined)?.account || "");
  const payer = String(credit.account || credit.payer || setupAddress || fromPage || priorAccount || "");
  log.credit = {
    path: credit.path,
    status: credit.status,
    account: payer,
    datasetId: credit.datasetId ?? credit.dataset,
  };
  if (!payer) throw new Error("no payer/account after handover");
  const v2 = await isAccount(FACTORY, payer);
  const v1 = await isAccount(LEGACY, payer);
  steps.v2Account = { ok: v2 && !v1, account: payer, v2, v1, path: credit.path };
  if (!v2 || v1) throw new Error(`assigned account is not v2-only: v2=${v2} v1=${v1} ${payer}`);
  say(`v2 account ${payer} path=${credit.path}`);

  // Authorize session if the button is shown
  if (await visible(page, "account") && !(await visible(page, "authorize-session")) && !(await visible(page, "session-status"))) {
    await page.getByTestId("account").click().catch(() => undefined);
  }
  if (await visible(page, "authorize-session")) {
    say("clicking authorize-session");
    await page.getByTestId("authorize-session").first().click();
    await waitUntil(4 * 60_000, "session ready", sessionReady);
  }
  steps.session = { ok: true, text: (await textOf(page)).slice(0, 300) };
  log.tSessionReady = new Date().toISOString();
  log.secPaymentToSessionReady = Math.round((Date.now() - tPayment) / 1000);
  await snap(page, "session-ready");
  say(`session ready ${log.secPaymentToSessionReady}s after payment return`);

  // --- Drive file save ---
  const fileName = "live-e2e.txt";
  const fileBytes = Buffer.from(`hello from live e2e ${new Date().toISOString()}\n`);
  // The account menu sat over the drive on the previous run; close it so toasts and the listing are visible
  // and the file-input change handler is not racing a menu re-render.
  await page.keyboard.press("Escape").catch(() => undefined);
  if (await visible(page, "account-menu")) {
    await page.getByTestId("account").click().catch(() => undefined);
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  const putFile = async (reason: string) => {
    await page.getByTestId("file-input").setInputFiles({ name: fileName, mimeType: "text/plain", buffer: fileBytes });
    say(`setInputFiles live-e2e.txt (${reason})`);
  };
  await putFile("initial");
  await snap(page, "after-upload");
  const tSave = Date.now();
  let lastSaveMark = 0;
  let retriedUpload = false;
  // The first resume's setInputFiles already committed this file (dataset 45 B, 10:32 PM CT).
  // A second setInputFiles opens a "replace existing" dialog; cancel it and accept the existing entry.
  const dismissReplace = async () => {
    const dialog = page.getByRole("dialog").filter({ hasText: /already exists/i });
    if (await dialog.count().catch(() => 0)) {
      await dialog.getByRole("button", { name: /^Cancel$/i }).click().catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
      say("dismissed replace-existing dialog (file already on the drive)");
      return true;
    }
    return false;
  };
  if (await page.getByTestId("entry").filter({ hasText: fileName }).count().catch(() => 0)) {
    await dismissReplace();
    say("live-e2e.txt already present on the drive");
  } else {
  await waitUntil(20 * 60_000, "drive file saved", async () => {
    await dismissReplace();
    const entryN = await page.getByTestId("entry").filter({ hasText: fileName }).count().catch(() => 0);
    const uploadN = await page.locator(".upload-row").count().catch(() => 0);
    const uploadDone = await page.locator('.upload-row[data-status=done]').count().catch(() => 0);
    const uploadErr = await page.locator('.upload-row[data-status=error]').count().catch(() => 0);
    const activity = await page.getByTestId("activity").innerText().catch(() => "");
    const toast = (await page.getByTestId("toast").allInnerTexts().catch(() => [])).join(" | ").slice(0, 240);
    const pending = await visible(page, "activity-indicator") || await page.locator(".upload-row[data-status=uploading], .upload-row[data-status=waiting]").count().catch(() => 0) > 0;
    const done = await page.locator('[data-testid=activity-item][data-status=done]').count().catch(() => 0);
    const err = await page.locator('[data-testid=activity-item][data-status=error]').count().catch(() => 0);
    const elapsed = Date.now() - tSave;
    if (entryN === 0 && uploadN === 0 && elapsed > 15_000 && !retriedUpload) {
      retriedUpload = true;
      say(`no entry or upload row after 15s; toast=${toast || "none"}; retrying upload`);
      await page.keyboard.press("Escape").catch(() => undefined);
      await putFile("retry after 15s");
      await snap(page, "upload-retry");
    }
    if (elapsed - lastSaveMark > 20_000) {
      lastSaveMark = elapsed;
      log.driveActivity = `${activity} toast=${toast}`.slice(0, 500);
      say(`save wait ${Math.round(elapsed / 1000)}s entries=${entryN} uploads=${uploadN} done=${done} err=${err} uploadDone=${uploadDone} uploadErr=${uploadErr} pending=${pending} toast=${toast || "none"} activity=${activity.slice(0, 180)}`);
      await snap(page, `save-${Math.round(elapsed / 1000)}s`);
    }
    if (uploadErr > 0 && uploadDone === 0 && entryN === 0 && elapsed > 30_000) {
      throw new Error(`drive upload failed: ${toast || activity}`.slice(0, 300));
    }
    if (err > 0 && done === 0 && entryN === 0 && elapsed > 30_000) {
      throw new Error(`drive save error: ${activity || toast}`.slice(0, 300));
    }
    const saveBtn = await page.getByRole("button", { name: /Save \d+ changes?/i }).count().catch(() => 0);
    const uploadComplete = await page.getByText(/upload complete/i).count().catch(() => 0);
    if (entryN > 0 && (uploadDone > 0 || done > 0 || uploadComplete > 0 || /Saved|committed|done|Uploaded/i.test(activity)) && saveBtn === 0) return true;
    if (entryN > 0 && saveBtn === 0 && elapsed > 8_000) return true;
    if (await visible(page, "authorize-session")) {
      await page.getByTestId("authorize-session").first().click().catch(() => undefined);
      await continuePasskey(page);
    }
    return false;
  });
  }
  await snap(page, "drive-saved");
  steps.driveSave = { ok: true, file: fileName, activity: (await page.getByTestId("activity").innerText().catch(() => "")).slice(0, 400) };
  log.tFirstSave = new Date().toISOString();
  log.secPaymentToFirstSave = Math.round((Date.now() - tPayment) / 1000);
  log.secSessionToFirstSave = Math.round((Date.now() - Date.parse(String(log.tSessionReady))) / 1000);
  say(`drive file saved; payment→ready ${log.secPaymentToSessionReady}s, ready→save ${log.secSessionToFirstSave}s, payment→save ${log.secPaymentToFirstSave}s`);

  // --- Identity profile ---
  await page.goto(`${SITE}/identity/`, { waitUntil: "networkidle" });
  await waitUntil(30_000, "identity connect or form", async () => {
    return (await visible(page, "identity-connect")) || (await visible(page, "identity-form"));
  });
  if (await visible(page, "identity-connect")) {
    await page.getByTestId("identity-connect").click();
  }
  await page.getByTestId("identity-form").waitFor({ timeout: 90_000 });
  const alreadySaved = await visible(page, "identity-saved");
  const existingName = await page.getByTestId("identity-name").inputValue().catch(() => "");
  if (alreadySaved && /Live E2E/i.test(existingName)) {
    const identityStatus = await page.getByTestId("identity-status").innerText().catch(() => "already saved");
    steps.identity = { ok: true, status: identityStatus, name: "Live E2E", skipped: true };
    await snap(page, "identity-saved");
    say(`identity already saved: ${identityStatus}`);
  } else {
    await page.getByTestId("identity-name").fill("Live E2E");
    await page.getByTestId("identity-bio").fill("Calibration live e2e profile");
    await snap(page, "identity-form");
    await page.getByTestId("identity-save").click();
    say("saving identity");
    await page.getByTestId("identity-saved").waitFor({ timeout: 15 * 60_000 });
    await snap(page, "identity-saved");
    const identityStatus = await page.getByTestId("identity-status").innerText().catch(() => "");
    steps.identity = { ok: true, status: identityStatus, name: "Live E2E" };
    say(`identity saved: ${identityStatus}`);
  }

  // --- Back to drive so it can process a FiPen save ---
  await page.goto(`${SITE}/`, { waitUntil: "networkidle" });
  await waitUntil(3 * 60_000, "drive session after identity", async () => {
    if (await visible(page, "payment-status") || await visible(page, "file-input")) {
      if (await visible(page, "authorize-session")) {
        await page.getByTestId("authorize-session").first().click().catch(() => undefined);
        return false;
      }
      return await visible(page, "file-input");
    }
    await continuePasskey(page);
    return false;
  });
  await snap(page, "drive-resumed");

  // --- Standalone FiPen ---
  const fipenName = "live-e2e.fipen";
  const fipenUrl =
    `${SITE}/fipen/?fifolders=1` +
    `&name=${encodeURIComponent(fipenName)}` +
    `&path=${encodeURIComponent("/" + fipenName)}` +
    `&volume=${encodeURIComponent(volumeName)}` +
    `&owner=${payer}`;
  const fipen = await ctx.newPage();
  fipen.on("console", (m) => {
    if (m.type() === "error") console.log("fipen console:", m.text().slice(0, 240));
  });
  await fipen.goto(fipenUrl, { waitUntil: "domcontentloaded" });
  say(`opened standalone fipen ${fipenUrl.replace(payer, "<payer>")}`);
  await snap(fipen, "fipen-open");
  // Embedded mode auto-clicks #blank, but the home overlay can still cover #input.
  // Wait for the editor (canvas / __editor.ready); click Blank if the home card is still up.
  await waitUntil(90_000, "fipen editor ready", async () => {
    const home = fipen.locator("#home");
    const homeUp = await home.isVisible().catch(() => false);
    if (homeUp) {
      const blank = fipen.locator("#blank");
      if (await blank.isVisible().catch(() => false)) {
        await blank.click().catch(() => undefined);
        say("clicked fipen #blank");
      }
    }
    const ready = await fipen.evaluate(() => (window as unknown as { __editor?: { ready?: boolean } }).__editor?.ready === true).catch(() => false);
    const canvas = await fipen.locator("#pages canvas").first().isVisible().catch(() => false);
    return Boolean(ready || canvas);
  });
  const titleBox = fipen.locator("#title");
  await titleBox.waitFor({ timeout: 30_000 });
  const dirty = /Unsaved changes/i;
  await waitUntil(45_000, "fipen text entered", async () => {
    await titleBox.click().catch(() => undefined);
    await fipen.keyboard.press("Control+a");
    await fipen.keyboard.type("Live E2E Note");
    await fipen.keyboard.press("Enter");
    const box = await fipen.locator("#pages canvas").first().boundingBox();
    if (!box) return false;
    await fipen.mouse.click(box.x + Math.min(120, box.width / 2), box.y + Math.min(80, box.height / 2));
    await fipen.keyboard.type("Hello from standalone FiPen live e2e.");
    const status = await fipen.locator("#status").innerText({ timeout: 2_000 }).catch(() => "");
    return dirty.test(status) && !/^New, unsaved$/i.test(status.trim());
  });
  await fipen.locator("#p2p-save").waitFor({ timeout: 30_000 });
  await fipen.locator("#p2p-save").click();
  await snap(fipen, "fipen-typed");
  say("fipen save clicked; waiting for queued/saved");
  let fipenLogged = 0;
  await waitUntil(20 * 60_000, "fipen saved to volume", async () => {
    const state = await fipen.locator("#status").getAttribute("data-save", { timeout: 2_000 }).catch(() => "");
    const statusText = await fipen.locator("#status").innerText({ timeout: 2_000 }).catch(() => "");
    log.fipenState = state || statusText;
    const elapsed = Date.now() - fipenLogged;
    if (fipenLogged === 0 || elapsed > 20_000) {
      fipenLogged = Date.now();
      say(`fipen wait state=${state || "none"} text=${(statusText || "").slice(0, 120)}`);
      await snap(fipen, "fipen-wait");
    }
    if (state === "failed" || /save failed/i.test(statusText)) {
      throw new Error(`fipen save failed: ${(statusText || await textOf(fipen)).slice(0, 200)}`);
    }
    if (/^New, unsaved$|^Unsaved changes$/i.test((statusText || "").trim()) || state === "unsaved") {
      await fipen.locator("#p2p-save").click().catch(() => undefined);
    }
    if (state === "saved" || state === "queued") return true;
    if (/Saved to Filecoin|Queued for FiFolders|All changes saved/i.test(statusText)) return true;
    // drive tab may show the entry / activity
    const entry = await page.getByTestId("entry").filter({ hasText: "live-e2e" }).count().catch(() => 0);
    const activity = await page.getByTestId("activity").innerText().catch(() => "");
    if (entry > 0 && /Saved “?Live E2E|Saved “?live-e2e/i.test(activity)) return true;
    return false;
  });
  await snap(fipen, "fipen-saved");
  await snap(page, "drive-after-fipen");
  steps.fipen = { ok: true, state: log.fipenState, url: fipenUrl.replace(payer, "<payer>") };
  say("fipen doc saved");
  await fipen.close();

  // --- Person page ---
  await page.goto(`${SITE}/person/?id=${payer}`, { waitUntil: "networkidle" });
  await waitUntil(8 * 60_000, "person profile visible", async () => {
    if (await visible(page, "person-page") && await visible(page, "person-name")) {
      const name = (await page.getByTestId("person-name").innerText().catch(() => "")).trim();
      if (/Live E2E/i.test(name)) return true;
    }
    if (await visible(page, "person-missing")) {
      await page.waitForTimeout(8000);
      await page.reload({ waitUntil: "networkidle" }).catch(() => undefined);
    }
    return false;
  });
  const personName = (await page.getByTestId("person-name").innerText().catch(() => "")).trim();
  const personBio = (await page.getByTestId("person-bio").innerText().catch(() => "")).trim();
  await snap(page, "person-page");
  const person = { ok: /Live E2E/i.test(personName), name: personName, bio: personBio, id: payer };
  steps.person = person;
  if (!person.ok) throw new Error(`person page name mismatch: ${personName}`);
  say(`person page shows ${personName}`);

  log.ok = true;
} catch (error) {
  log.ok = false;
  log.error = error instanceof Error ? error.message.split("\n")[0] : String(error);
  log.at = page.url().replace(/session_id=[^&]+/, "session_id=…");
  log.text = await textOf(page).catch(() => "");
  await snap(page, "error").catch(() => undefined);
  for (const [i, extra] of page.context().pages().entries()) {
    if (extra === page) continue;
    log[`atTab${i}`] = extra.url();
    await snap(extra, `error-tab${i}`).catch(() => undefined);
  }
  say(`FAIL: ${log.error}`);
} finally {
  stopCreditPoll();
  const txs = executeBodies
    .map((b) => {
      if (!b || typeof b !== "object") return null;
      const rec = b as Record<string, unknown>;
      return rec.hash || rec.tx || rec.transactionHash || rec.id || null;
    })
    .filter(Boolean);
  log.executeTxs = txs;
  log.sponsorCalls = [...new Set(sponsorPaths)];
  try {
    const status1 = await (await fetch(WORKER + "/status", { headers: { "user-agent": "Mozilla/5.0" } })).json();
    log.statusAfter = { funds: status1.funds, pool: status1.pool, gasKilled: status1.gas?.killed };
  } catch (e) {
    log.statusAfterError = e instanceof Error ? e.message : String(e);
  }
  log.finished = new Date().toISOString();
  flush();
  console.log(JSON.stringify({ ok: log.ok, error: log.error, steps: log.steps, executeTxs: log.executeTxs, statusAfter: log.statusAfter }, null, 2));
  await browser.close();
}
