// Cloudflare Worker host for the sponsor backend (Calibration). One Durable Object instance ("sponsor") owns all
// mutable state, so the hot wallet's nonce sequence, webhook idempotency, rate limits and the warm pool are
// serialized in one place:
//   • requests → SponsorDO.fetch → the same runtime-neutral core as the Node server (core.ts)
//   • state    → DO storage, one key per record ("s:<collection>:<id>"), written on every change
//   • long work (pool builds ~4 min, credits) → DO alarms (re-armed until the pool is full and credits are settled)
//   • Cron Trigger → pool refill + retry of deferred sweeps (SPONSOR_SWEEP_ACCOUNTS)
//
// Networks: Calibration (Stripe test mode) at the root; mainnet (Stripe live mode) under /mainnet, in its own Durable
// Object with its own wallet, factory and Stripe keys. Mainnet answers 503 until SPONSOR_FACTORY_MAINNET and a funded
// SPONSOR_KEY_MAINNET are set.
// Secrets (set by .github/workflows/sponsor-worker.yml from GitHub Actions secrets; never in the repo):
//   Calibration: SPONSOR_KEY, STRIPE_SECRET_KEY (sk_test_/rk_test_), STRIPE_WEBHOOK_SECRET
//   Mainnet:     SPONSOR_KEY_MAINNET, STRIPE_LIVE_SECRET_KEY (rk_live_/sk_live_), STRIPE_LIVE_WEBHOOK_SECRET
import { DurableObject } from "cloudflare:workers";
import { getAddress, type Hex } from "viem";
import { CORS_HEADERS, configFromEnv, createSponsorCore, type SponsorCore, type SponsorState } from "./core.js";

export interface Env {
  SPONSOR: DurableObjectNamespace<SponsorDO>;
  SPONSOR_MAINNET: DurableObjectNamespace<SponsorMainnetDO>;
  SPONSOR_KEY: string;
  SPONSOR_RPC?: string;
  [name: string]: unknown;
}

const COLLECTIONS = ["users", "checkouts", "credits", "pool", "sweeps", "gas"] as const;
const POOL_BUILDS_PER_ALARM = 1;

function stringEnv(env: Env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")) as Record<string, string>;
}

/** The core's env view for one network (mainnet reads the *_MAINNET / STRIPE_LIVE_* names). */
export function networkEnv(env: Record<string, string | undefined>, network: "calibration" | "mainnet"): Record<string, string | undefined> {
  if (network === "calibration") {
    return { ...env, SPONSOR_NETWORK: "calibration" };
  }
  return {
    SPONSOR_NETWORK: "mainnet",
    SPONSOR_KEY: env.SPONSOR_KEY_MAINNET,
    SPONSOR_FACTORY: env.SPONSOR_FACTORY_MAINNET,
    SPONSOR_PROVIDER_ID: env.SPONSOR_PROVIDER_ID_MAINNET,
    SPONSOR_POOL_SIZE: env.SPONSOR_POOL_SIZE_MAINNET,
    SPONSOR_POOL_SEED_USDFC: env.SPONSOR_POOL_SEED_USDFC,
    SPONSOR_ALLOWED_ORIGINS: env.SPONSOR_ALLOWED_ORIGINS_MAINNET,
    SPONSOR_SWEEP_ACCOUNTS: env.SPONSOR_SWEEP_ACCOUNTS_MAINNET,
    SPONSOR_FACTORY_LEGACY: env.SPONSOR_FACTORY_LEGACY_MAINNET,
    SPONSOR_BEACON: env.SPONSOR_BEACON_MAINNET,
    SPONSOR_REGISTRY: env.SPONSOR_REGISTRY_MAINNET,
    SPONSOR_RPC: env.SPONSOR_RPC_MAINNET,
    STRIPE_SECRET_KEY: env.STRIPE_LIVE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_LIVE_WEBHOOK_SECRET,
    ...Object.fromEntries(Object.entries(env).filter(([key]) => /^SPONSOR_(RESERVE|SETUP_FEE|MIN_|MAX_|STRIPE_FEE|USDFC_PER|LOW_|REFUND_|GAS_|POOL_MIN_|POOL_TOPUP_|POOL_MAX_AGE_)/.test(key))),
  };
}

export class SponsorDO extends DurableObject<Env> {
  protected get network(): "calibration" | "mainnet" {
    return "calibration";
  }
  private core!: SponsorCore;
  /** Why the core could not start (e.g. mainnet wallet/factory not configured yet). */
  private disabled: string | null = null;
  private saved = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const state: Partial<SponsorState> = { users: {}, checkouts: {}, credits: {}, pool: {}, sweeps: {}, gas: { budget: { accounts: {}, ips: {}, reservations: {} } } };
      for (const [key, value] of await ctx.storage.list<string>({ prefix: "s:" })) {
        const [, collection, ...rest] = key.split(":");
        const bucket = (state as Record<string, Record<string, unknown>>)[collection!];
        if (!bucket) continue;
        bucket[rest.join(":")] = JSON.parse(value);
        this.saved.set(key, value);
      }
      const view = networkEnv(stringEnv(env), this.network);
      const missing = ["SPONSOR_KEY", "SPONSOR_FACTORY"].filter((name) => !view[name]);
      if (missing.length) {
        this.disabled = `${this.network} sponsor not configured: needs ${this.network === "mainnet" ? missing.map((name) => `${name}_MAINNET`).join(", ") : missing.join(", ")}`;
        return;
      }
      try {
        this.core = createSponsorCore(configFromEnv(view), { sponsorKey: view.SPONSOR_KEY as Hex, rpc: view.SPONSOR_RPC, state, persist: (current) => this.persist(current) });
      } catch (error) {
        this.disabled = `${this.network} sponsor misconfigured: ${error instanceof Error ? error.message : String(error)}`;
        return;
      }
      await this.arm();
    });
  }

  /** Write changed records (and drop removed ones); DO output gates hold responses until the writes are durable. */
  private persist(state: SponsorState): void {
    const next = new Map<string, string>();
    for (const collection of COLLECTIONS) for (const [id, record] of Object.entries((state[collection] ?? {}) as Record<string, unknown>)) next.set(`s:${collection}:${id}`, JSON.stringify(record));
    const changed: Record<string, string> = {};
    for (const [key, value] of next) if (this.saved.get(key) !== value) changed[key] = value;
    const removed = [...this.saved.keys()].filter((key) => !next.has(key));
    const entries = Object.entries(changed);
    for (let i = 0; i < entries.length; i += 128) void this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    for (let i = 0; i < removed.length; i += 128) void this.ctx.storage.delete(removed.slice(i, i + 128));
    this.saved = next;
  }

  private busy(): boolean {
    if (this.disabled) return false;
    const state = this.core.state;
    const pending = Object.values(state.credits).some((credit) => credit.status === "pending");
    const landing = Object.values(state.credits).some((credit) => credit.status === "done" && credit.finality === "sent");
    const size = this.core.config.pool?.size ?? 0;
    const factory = this.core.config.factory;
    const legacy = this.core.config.legacyFactory;
    const currentReady = Object.values(state.pool).filter((entry) => {
      if (entry.status !== "ready" && entry.status !== "seeding") return false;
      return Boolean(entry.factory) && getAddress(entry.factory!) === getAddress(factory);
    }).length;
    const needsClassify = Boolean(legacy) && Object.values(state.pool).some((entry) => entry.status === "ready" && (!entry.factory || getAddress(entry.factory) !== getAddress(factory)));
    const ready = !legacy && !Object.values(state.pool).some((entry) => entry.factory)
      ? Object.values(state.pool).filter((entry) => entry.status === "ready" || entry.status === "seeding").length
      : currentReady;
    return pending || landing || ready < size || needsClassify;
  }

  /** Keep an alarm armed while there is background work (pending credits or a short pool). */
  private async arm(delayMs = 1_000): Promise<void> {
    if (!this.busy()) return;
    const current = await this.ctx.storage.getAlarm();
    // Also re-arm a stale alarm (one that should have fired long ago, e.g. lost across a redeploy).
    if (current === null || current > Date.now() + delayMs || current < Date.now() - 60_000) await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  private lastAlarm: { at: string; error?: string } | null = null;

  async alarm(): Promise<void> {
    if (this.disabled) return;
    this.lastAlarm = { at: new Date().toISOString() };
    try {
      await this.runAlarm();
    } catch (error) {
      this.lastAlarm.error = error instanceof Error ? error.message : String(error);
      console.error("[sponsor] alarm:", this.lastAlarm.error);
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  private async runAlarm(): Promise<void> {
    await this.core.settled();
    await this.core.checkHandoverFinality();
    await this.core.trimPool();
    await this.core.refillPool({ max: POOL_BUILDS_PER_ALARM });
    await this.core.settled();
    // A failed build stops the refill until the next cron tick (no hot loop on a broken provider).
    const failedRecently = Object.values(this.core.state.pool).some((entry) => entry.status === "failed" && !entry.error?.startsWith("interrupted"));
    if (!failedRecently) await this.arm(2_000);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (this.disabled) {
      const body = url.pathname === "/health" ? { ok: false, network: this.network, configured: false, error: this.disabled } : { error: this.disabled };
      return new Response(JSON.stringify(body), { status: 503, headers: CORS_HEADERS });
    }
    if (url.pathname === "/__cron") {
      const tick = await this.core.cronTick();
      await this.ctx.storage.deleteAlarm();
      await this.arm(1_000);
      return Response.json(tick);
    }
    const out = await this.core.handle({ method: request.method, url: url.pathname + url.search, header: (name) => request.headers.get(name) ?? undefined, body: request.method === "GET" || request.method === "HEAD" ? "" : await request.text() });
    await this.arm();
    let body = out.body;
    if (url.pathname === "/pool" && out.status === 200) {
      const alarm = await this.ctx.storage.getAlarm();
      body = { ...(out.body as object), alarm: alarm === null ? null : new Date(alarm).toISOString(), lastAlarm: this.lastAlarm };
    }
    return new Response(out.status === 204 ? null : JSON.stringify(body), { status: out.status, headers: { ...CORS_HEADERS, ...out.headers } });
  }
}

/** Mainnet: same code, its own state, wallet, factory and live Stripe keys. */
export class SponsorMainnetDO extends SponsorDO {
  protected override get network(): "calibration" | "mainnet" {
    return "mainnet";
  }
}

function stub(env: Env, network: "calibration" | "mainnet" = "calibration") {
  return network === "mainnet" ? env.SPONSOR_MAINNET.get(env.SPONSOR_MAINNET.idFromName("sponsor-mainnet")) : env.SPONSOR.get(env.SPONSOR.idFromName("sponsor"));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__")) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: CORS_HEADERS });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (url.pathname === "/mainnet" || url.pathname.startsWith("/mainnet/")) {
      url.pathname = url.pathname.slice("/mainnet".length) || "/";
      return stub(env, "mainnet").fetch(new Request(url, request));
    }
    return stub(env).fetch(request);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const network of ["calibration", "mainnet"] as const) {
      ctx.waitUntil(stub(env, network).fetch("https://sponsor.internal/__cron").then((response) => response.text()));
    }
  },
} satisfies ExportedHandler<Env>;
