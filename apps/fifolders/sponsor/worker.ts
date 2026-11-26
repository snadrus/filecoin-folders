// Cloudflare Worker host for the sponsor backend (Calibration). One Durable Object instance ("sponsor") owns all
// mutable state, so the hot wallet's nonce sequence, webhook idempotency, rate limits and the warm pool are
// serialized in one place:
//   • requests → SponsorDO.fetch → the same runtime-neutral core as the Node server (core.ts)
//   • state    → DO storage, one key per record ("s:<collection>:<id>"), written on every change
//   • long work (pool builds ~4 min, credits) → DO alarms (re-armed until the pool is full and credits are settled)
//   • Cron Trigger → pool refill + retry of deferred sweeps (SPONSOR_SWEEP_ACCOUNTS)
// Secrets (wrangler secret put): SPONSOR_KEY, STRIPE_WEBHOOK_SECRET, later STRIPE_SECRET_KEY.
import { DurableObject } from "cloudflare:workers";
import type { Hex } from "viem";
import { CORS_HEADERS, configFromEnv, createSponsorCore, type SponsorCore, type SponsorState } from "./core.js";

export interface Env {
  SPONSOR: DurableObjectNamespace<SponsorDO>;
  SPONSOR_KEY: string;
  SPONSOR_RPC?: string;
  [name: string]: unknown;
}

const COLLECTIONS = ["users", "checkouts", "credits", "pool", "sweeps"] as const;
const POOL_BUILDS_PER_ALARM = 1;

function stringEnv(env: Env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")) as Record<string, string>;
}

export class SponsorDO extends DurableObject<Env> {
  private core!: SponsorCore;
  private saved = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const state: Partial<SponsorState> = { users: {}, checkouts: {}, credits: {}, pool: {}, sweeps: {} };
      for (const [key, value] of await ctx.storage.list<string>({ prefix: "s:" })) {
        const [, collection, ...rest] = key.split(":");
        const bucket = (state as Record<string, Record<string, unknown>>)[collection!];
        if (!bucket) continue;
        bucket[rest.join(":")] = JSON.parse(value);
        this.saved.set(key, value);
      }
      this.core = createSponsorCore(configFromEnv(stringEnv(env)), { sponsorKey: env.SPONSOR_KEY as Hex, rpc: env.SPONSOR_RPC, state, persist: (current) => this.persist(current) });
      await this.arm();
    });
  }

  /** Write changed records (and drop removed ones); DO output gates hold responses until the writes are durable. */
  private persist(state: SponsorState): void {
    const next = new Map<string, string>();
    for (const collection of COLLECTIONS) for (const [id, record] of Object.entries(state[collection])) next.set(`s:${collection}:${id}`, JSON.stringify(record));
    const changed: Record<string, string> = {};
    for (const [key, value] of next) if (this.saved.get(key) !== value) changed[key] = value;
    const removed = [...this.saved.keys()].filter((key) => !next.has(key));
    const entries = Object.entries(changed);
    for (let i = 0; i < entries.length; i += 128) void this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    for (let i = 0; i < removed.length; i += 128) void this.ctx.storage.delete(removed.slice(i, i + 128));
    this.saved = next;
  }

  private busy(): boolean {
    const state = this.core.state;
    const pending = Object.values(state.credits).some((credit) => credit.status === "pending");
    const size = this.core.config.pool?.size ?? 0;
    const ready = Object.values(state.pool).filter((entry) => entry.status === "ready" || entry.status === "seeding").length;
    return pending || ready < size;
  }

  /** Keep an alarm armed while there is background work (pending credits or a short pool). */
  private async arm(delayMs = 1_000): Promise<void> {
    if (!this.busy()) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > Date.now() + delayMs) await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  async alarm(): Promise<void> {
    await this.core.settled();
    await this.core.refillPool({ max: POOL_BUILDS_PER_ALARM });
    await this.core.settled();
    // A failed build stops the refill until the next cron tick (no hot loop on a broken provider).
    const failedRecently = Object.values(this.core.state.pool).some((entry) => entry.status === "failed" && !entry.error?.startsWith("interrupted"));
    if (!failedRecently) await this.arm(2_000);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__cron") {
      const swept = await this.core.sweepDeferred();
      await this.ctx.storage.deleteAlarm();
      await this.arm(1_000);
      return Response.json({ swept, pool: this.core.poolStatus().counts });
    }
    const out = await this.core.handle({ method: request.method, url: url.pathname + url.search, header: (name) => request.headers.get(name) ?? undefined, body: request.method === "GET" || request.method === "HEAD" ? "" : await request.text() });
    await this.arm();
    return new Response(out.status === 204 ? null : JSON.stringify(out.body), { status: out.status, headers: CORS_HEADERS });
  }
}

function stub(env: Env) {
  return env.SPONSOR.get(env.SPONSOR.idFromName("sponsor"));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__")) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: CORS_HEADERS });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    return stub(env).fetch(request);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(stub(env).fetch("https://sponsor.internal/__cron").then((response) => response.text()));
  },
} satisfies ExportedHandler<Env>;
