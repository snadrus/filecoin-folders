import { sponsorUrl, type ChainChoice, readNetworkPreference } from "./config.js";

export async function sponsorCall<T>(path: string, body?: unknown, chain?: ChainChoice): Promise<T> {
  const base = sponsorUrl(chain ?? readNetworkPreference());
  if (!base) throw new Error("Sponsor is not configured for this network.");
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body, (_, value) => (typeof value === "bigint" ? value.toString() : value)) }),
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(json.error || `Sponsor ${path} failed (${response.status})`);
  return json;
}
