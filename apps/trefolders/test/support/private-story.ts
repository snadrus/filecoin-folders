// Live private-folder story for a sponsored (passkey) account: create, upload, share, guest opens, delete, terminate.
import type { Browser, BrowserContext, Page } from "@playwright/test";

const RPC = "https://api.calibration.node.glif.io/rpc/v1";

export interface StoryIO {
  page: Page;
  browser: Browser;
  say: (msg: string) => void;
  snap: (p: Page, name: string) => Promise<string>;
  steps: Record<string, unknown>;
  payer: string;
  credentials: unknown[];
  site: string;
}

const visible = async (p: Page, testId: string) => p.getByTestId(testId).first().isVisible().catch(() => false);

async function openMenu(p: Page) {
  await p.keyboard.press("Escape").catch(() => undefined);
  if (!(await visible(p, "account-menu"))) await p.getByTestId("account").click().catch(() => undefined);
  await p.getByTestId("account-menu").waitFor({ timeout: 30_000 });
}

async function waitFor(p: Page, ms: number, label: string, fn: () => Promise<boolean>, every = 3_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return Math.round((Date.now() - t0) / 1000);
    await p.waitForTimeout(every);
  }
  throw new Error(`timeout: ${label}`);
}

async function datasetsOnChain(payer: string) {
  const { Synapse } = await import("@filoz/synapse-sdk");
  const { calibration } = await import("@filoz/synapse-core/chains");
  const { createPublicClient, custom, http } = await import("viem");
  const client = createPublicClient({ transport: http(RPC) });
  const transport = custom({ request: (args: { method: string; params?: unknown }) => client.request(args as never) });
  const synapse = Synapse.create({ account: payer as `0x${string}`, chain: calibration as never, transport, source: "fifolders" } as never);
  return (await synapse.storage.findDataSets({ address: payer as `0x${string}` })) as Array<{ dataSetId: bigint; pdpEndEpoch: bigint; isLive: boolean; metadata?: Record<string, string>; activePieceCount?: bigint }>;
}

export async function runPrivateStory(io: StoryIO): Promise<void> {
  const { page, say, snap, steps } = io;
  page.on("dialog", (d) => void d.accept());
  const before = new Set((await datasetsOnChain(io.payer)).map((d) => d.dataSetId.toString()));

  // 1. Create a private dataset (passkey PRF → Keysmith group key; sponsor opens it with read=restricted).
  await openMenu(page);
  await page.getByTestId("create-private-dataset").first().click();
  say("clicked create-private-dataset");
  let id = "";
  let lastTry = Date.now();
  const secCreate = await waitFor(page, 12 * 60_000, "private dataset on chain", async () => {
    const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    if (/can't make an encryption key|Dataset was not created|not allowed/.test(text)) throw new Error(`create refused: ${text.slice(0, 300)}`);
    if (/session key not authorized/.test(text) && Date.now() - lastTry > 45_000) {
      lastTry = Date.now();
      say("create hit the session-key race; clicking again");
      await openMenu(page);
      await page.getByTestId("create-private-dataset").first().click().catch(() => undefined);
    }
    const now = await datasetsOnChain(io.payer).catch(() => []);
    const made = now.find((d) => !before.has(d.dataSetId.toString()) && d.metadata?.read === "restricted");
    if (made) id = made.dataSetId.toString();
    return Boolean(made);
  }, 10_000);
  const meta = (await datasetsOnChain(io.payer)).find((d) => d.dataSetId.toString() === id)?.metadata ?? {};
  steps.privateCreate = { ok: true, datasetId: id, seconds: secCreate, metadataKeys: Object.keys(meta).sort(), read: meta.read };
  say(`private dataset #${id} created in ${secCreate}s; keys ${Object.keys(meta).sort().join(",")}`);

  // 2. Open it (selecting it opens the drive through the gate).
  await page.reload({ waitUntil: "networkidle" });
  await waitFor(page, 120_000, "signed in after reload", async () => {
    for (const t of ["passkey-continue", "passkey-existing"]) if (await visible(page, t)) await page.getByTestId(t).first().click().catch(() => undefined);
    return visible(page, "account");
  });
  await openMenu(page);
  const item = page.getByTestId("dataset-item").filter({ hasText: `#${id}` });
  await item.waitFor({ timeout: 120_000 });
  const badge = await item.getByTestId("dataset-visibility").getAttribute("data-visibility");
  await item.click();
  await waitFor(page, 5 * 60_000, "private drive open", async () => {
    if (await visible(page, "open-drive")) await page.getByTestId("open-drive").click().catch(() => undefined);
    return (await visible(page, "file-input")) && !(await visible(page, "drive-loading"));
  });
  await openMenu(page);
  const current = (await page.getByTestId("current-visibility").innerText().catch(() => "")).trim();
  await snap(page, "private-open");
  steps.privateOpen = { ok: badge === "private" && /Private/.test(current), badge, current };
  if (!/Private/.test(current)) throw new Error(`current dataset not shown private: ${current}`);
  await page.keyboard.press("Escape").catch(() => undefined);

  // 3. Upload an encrypted file.
  await page.getByTestId("nav-drive").click().catch(() => undefined);
  const name = `private-${Date.now()}.txt`;
  const body = `only people with the link can read this ${name}`;
  await page.getByTestId("file-input").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(`${body}\n`) });
  const secUpload = await waitFor(page, 15 * 60_000, "upload saved", async () => {
    const entry = (await page.getByTestId("entry").filter({ hasText: name }).count()) > 0;
    const uploads = await page.getByTestId("upload-panel").innerText().catch(() => "");
    const busy = !/upload(s)? complete/i.test(uploads) || (await page.locator(".upload-row[data-status=uploading]").count()) > 0;
    const err = (await page.locator("[data-testid=activity-item][data-status=error]").count()) > 0;
    if (err) throw new Error(`upload error: ${(await page.getByTestId("activity").innerText().catch(() => "")).slice(0, 300)}`);
    return entry && !busy;
  }, 5_000);
  await snap(page, "private-uploaded");
  steps.txlogAfterUpload = await page.locator("[data-testid=activity-item]").evaluateAll((els) => els.map((el) => `${(el as HTMLElement).dataset.status}:${el.textContent?.replace(/\s+/g, " ").trim().slice(0, 120)}`)).catch(() => []);
  steps.privateUpload = { ok: true, file: name, seconds: secUpload };
  say(`uploaded ${name} in ${secUpload}s`);

  // 4. Share link; a guest (fresh browser, no account) opens it.
  const entry = page.getByTestId("entry").filter({ hasText: name }).first();
  await entry.click({ button: "right" });
  await page.getByRole("button", { name: /Details/ }).first().click();
  const link = page.getByTestId("share-link");
  await link.waitFor({ timeout: 180_000 });
  const href = (await link.getAttribute("href"))!;
  await snap(page, "private-share");
  await page.keyboard.press("Escape").catch(() => undefined);
  const guest: BrowserContext = await io.browser.newContext();
  const g = await guest.newPage();
  await g.goto(href);
  await g.getByTestId("share-preview").filter({ hasText: body }).waitFor({ timeout: 180_000 });
  await snap(g, "private-guest");
  const hash = new URLSearchParams(new URL(href).hash.slice(1));
  const piece = hash.get("piece") || "";
  const sp = (hash.get("s") || "").split(",")[0];
  const anon = piece && sp ? (await g.request.get(`${sp}/piece/${piece}`)).status() : -1;
  const noGrant = piece && sp ? (await g.request.get(`${sp}/download/${piece}`)).status() : -1;
  await guest.close();
  steps.privateShare = { ok: true, link: href.replace(/#.*/, "#…"), guestOpened: true, anonymousPiece: anon, downloadWithoutGrant: noGrant, hasQuery: new URL(href).search !== "" };
  say(`guest opened the link; anonymous /piece/ ${anon}, /download/ without grant ${noGrant}`);
  if (anon === 200) throw new Error("private piece readable anonymously");

  // 5. Delete the file forever (schedules the piece removal with the session key).
  await page.getByTestId("entry").filter({ hasText: name }).first().click({ button: "right" });
  await page.getByRole("button", { name: /Move to trash/ }).first().click();
  await page.getByTestId("nav-trash").click();
  await page.getByTestId("entry").filter({ hasText: name }).first().click({ button: "right" });
  await page.getByRole("button", { name: /Delete forever/ }).first().click();
  let removal: Record<string, unknown> | null = null;
  const secRemove = await waitFor(page, 10 * 60_000, "piece removal confirmed", async () => {
    const records = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => /remov/i.test(k)).map(([k, v]) => [k, v] as const));
    for (const [, v] of records) {
      try {
        const parsed = JSON.parse(v) as Record<string, Record<string, { confirmed?: boolean; transactionHash?: string }>>;
        for (const [pieceCid, byDataset] of Object.entries(parsed)) {
          const hit = byDataset?.[id];
          if (hit?.confirmed && hit.transactionHash) removal = { pieceCid, ...hit };
        }
      } catch {
        /* not ours */
      }
    }
    return Boolean(removal);
  }, 5_000);
  await snap(page, "private-deleted");
  steps.privateDelete = { ok: true, seconds: secRemove, ...(removal ?? {}) };
  say(`piece removal confirmed in ${secRemove}s: ${JSON.stringify(removal)}`);

  // 6. Terminate the private dataset from the account menu.
  await openMenu(page);
  const term = page.getByTestId("terminate-dataset");
  await term.waitFor({ timeout: 60_000 });
  const label = await term.innerText();
  if (!label.includes(`#${id}`)) throw new Error(`terminate button targets ${label}, expected #${id}`);
  await term.click();
  const secTerm = await waitFor(page, 10 * 60_000, "terminated on chain", async () => {
    const d = (await datasetsOnChain(io.payer).catch(() => [])).find((x) => x.dataSetId.toString() === id);
    return Boolean(d && (d.pdpEndEpoch > 0n || d.isLive === false));
  }, 10_000);
  await snap(page, "private-terminated");
  const after = (await datasetsOnChain(io.payer)).find((x) => x.dataSetId.toString() === id);
  steps.privateTerminate = { ok: true, seconds: secTerm, pdpEndEpoch: after?.pdpEndEpoch?.toString(), isLive: after?.isLive };
  say(`dataset #${id} terminated in ${secTerm}s (pdpEndEpoch ${after?.pdpEndEpoch})`);
}

/** Same passkey on an authenticator without PRF: creating a private dataset is refused before any sponsor call. */
export async function runNoPrfRefusal(io: StoryIO): Promise<void> {
  const ctx = await io.browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: false },
  } as never);
  for (const credential of io.credentials) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential } as never);
  const datasetCalls: string[] = [];
  p.on("request", (r) => {
    if (/\/dataset$/.test(new URL(r.url()).pathname)) datasetCalls.push(r.method());
  });
  await p.goto(io.site, { waitUntil: "networkidle" });
  await waitFor(p, 120_000, "signed in (no PRF)", async () => {
    for (const t of ["passkey-continue", "passkey-existing"]) if (await visible(p, t)) await p.getByTestId(t).first().click().catch(() => undefined);
    return visible(p, "account");
  });
  await openMenu(p);
  await p.getByTestId("create-private-dataset").first().click();
  let text = "";
  await waitFor(p, 5 * 60_000, "refusal message", async () => {
    text = (await p.locator("body").innerText()).replace(/\s+/g, " ");
    if (await visible(p, "authorize-session")) await p.getByTestId("authorize-session").first().click().catch(() => undefined);
    return /can't make an encryption key/.test(text);
  });
  await io.snap(p, "no-prf-refused");
  const message = /This passkey can't make an encryption key[^.]*\.[^.]*\./.exec(text)?.[0] ?? "";
  io.steps.noPrf = { ok: datasetCalls.length === 0, message, sponsorDatasetCalls: datasetCalls.length };
  io.say(`no-PRF passkey refused: "${message}" (sponsor /dataset calls: ${datasetCalls.length})`);
  await ctx.close();
}
