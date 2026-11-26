// Node host for the sponsor backend (local dev + tests): node:http around the runtime-neutral core (core.ts), with
// state in a JSON file. The Cloudflare deployment (worker.ts) runs the same core inside a Durable Object.
//   SPONSOR_KEY=0x… SPONSOR_FACTORY=0x… [STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / SPONSOR_STRIPE_FAKE=1] tsx apps/fifolders/sponsor/server.ts
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Hex } from "viem";
import { CORS_HEADERS, configFromEnv as coreConfigFromEnv, createSponsorCore, HttpError, type SponsorConfig, type SponsorDeps, type SponsorState } from "./core.js";

export * from "./core.js";

/** Node config: process.env, state next to this file unless SPONSOR_STATE is set. */
export function configFromEnv(env: Record<string, string | undefined> = process.env): SponsorConfig {
  return coreConfigFromEnv(env, { statePath: new URL("./sponsor-state.json", import.meta.url).pathname });
}

export function createSponsor(config: SponsorConfig, deps: SponsorDeps = {}) {
  const path = config.statePath;
  const state = deps.state ?? (path && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<SponsorState>) : {});
  const persist = deps.persist ?? ((current: SponsorState) => path && writeFileSync(path, JSON.stringify(current, null, 2)));
  const core = createSponsorCore(config, { sponsorKey: process.env.SPONSOR_KEY as Hex | undefined, ...deps, state, persist });
  const server: Server = createServer(async (req, res) => {
    let body = "";
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 256 * 1024) throw new HttpError(413, "body too large");
      }
    } catch (error) {
      res.writeHead(error instanceof HttpError ? error.status : 400, CORS_HEADERS);
      return res.end(JSON.stringify({ error: (error as Error).message }));
    }
    const out = await core.handle({ method: req.method ?? "GET", url: req.url ?? "/", header: (name) => req.headers[name.toLowerCase()] as string | undefined, body });
    res.writeHead(out.status, CORS_HEADERS);
    res.end(JSON.stringify(out.body));
  });
  return { ...core, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configFromEnv();
  const sponsor = createSponsor(config);
  const port = Number(process.env.SPONSOR_PORT ?? 8787);
  const stripe = config.stripe.secretKey ? config.stripe.secretKey.slice(0, 8) + "…" : config.stripe.fake ? "fake (local webhook)" : "off";
  sponsor.server.listen(port, () => console.log(`[sponsor] ${config.network} ${sponsor.relayer.address} factory ${config.factory} stripe ${stripe} pool ${config.pool?.size ?? 0} on :${port}`));
  void sponsor.refillPool();
  // Same background work as the Worker's cron: owed credits, pool refill, deferred sweeps.
  setInterval(() => void sponsor.cronTick().catch((error: unknown) => console.error("[sponsor] tick:", error)), 10 * 60_000);
}
