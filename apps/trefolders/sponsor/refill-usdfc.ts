// Automatic USDFC refill (GEL-4): Stripe USDC payout → Squid swap to USDFC on Filecoin → sponsor.
// Dry-run by default. Never logs secrets. Live sends require --send plus the secrets listed in docs/usdfc-refill.md.
import { formatUnits, parseUnits, type Address, type Hex } from "viem";

export const FILECOIN_MAINNET = 314;
export const USDFC_MAINNET = "0x80B98d3aa09ffff255c3ba4A241111Ff1262F045" as Address;
export const MAINNET_SPONSOR = "0xa69A4eF204eA951976bd6bDaCbd932Bbd18B08Db" as Address;
export const BASE_CHAIN_ID = 8453;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
export const SQUID_ROUTE_URL = "https://v2.api.squidrouter.com/v2/route";
export const STRIPE_PAYOUTS_VERSION = "2026-09-30.preview";

const ERC20_BALANCE = "0x70a08231";

export type RefillConfig = {
  dryRun: boolean;
  thresholdUsdfc: string;
  targetUsdfc: string;
  maxUsdcPerRun: string;
  sponsor: Address;
  filecoinRpc: string;
  usdfc: Address;
  sourceChainId: number;
  sourceUsdc: Address;
  sourceRpc: string;
  stripeKey?: string;
  stripeFinancialAccount?: string;
  stripePayoutMethod?: string;
  squidIntegratorId?: string;
  alertWebhook?: string;
  fetch?: typeof fetch;
  /** Live only: sign+send the Squid tx on the source chain. Not used in dry-run. */
  sendSourceTx?: (tx: { to: Address; data: Hex; value?: bigint }) => Promise<Hex>;
};

export type RefillPlan = {
  dryRun: boolean;
  sponsor: Address;
  sponsorUsdfc: string;
  sourceUsdc: string;
  thresholdUsdfc: string;
  targetUsdfc: string;
  maxUsdcPerRun: string;
  neededUsdfc: string;
  payoutUsdc: string;
  action: "skip" | "refill";
  reason: string;
  missing: string[];
};

export type RefillReport = RefillPlan & {
  squidQuote?: { toAmount?: string; requestId?: string };
  stripePayoutId?: string;
  squidTx?: Hex;
  alert?: string;
};

export function configFromEnv(env: NodeJS.Dict<string> = process.env, argv: string[] = process.argv): RefillConfig {
  const send = argv.includes("--send") || env.REFILL_SEND === "1";
  const dryRun = !send && env.REFILL_DRY_RUN !== "0";
  return {
    dryRun,
    thresholdUsdfc: env.REFILL_THRESHOLD_USDFC ?? "20",
    targetUsdfc: env.REFILL_TARGET_USDFC ?? "50",
    maxUsdcPerRun: env.REFILL_MAX_USDC_PER_RUN ?? "25",
    sponsor: (env.REFILL_SPONSOR ?? MAINNET_SPONSOR) as Address,
    filecoinRpc: env.MAINNET_RPC ?? "https://api.node.glif.io/rpc/v1",
    usdfc: (env.REFILL_USDFC ?? USDFC_MAINNET) as Address,
    sourceChainId: Number(env.REFILL_SOURCE_CHAIN_ID ?? BASE_CHAIN_ID),
    sourceUsdc: (env.REFILL_SOURCE_USDC ?? BASE_USDC) as Address,
    sourceRpc: env.REFILL_SOURCE_RPC ?? "https://mainnet.base.org",
    stripeKey: env.STRIPE_PAYOUT_KEY ?? env.STRIPE_LIVE_SECRET_KEY,
    stripeFinancialAccount: env.STRIPE_FINANCIAL_ACCOUNT,
    stripePayoutMethod: env.STRIPE_CRYPTO_PAYOUT_METHOD,
    squidIntegratorId: env.SQUID_INTEGRATOR_ID,
    alertWebhook: env.REFILL_ALERT_WEBHOOK,
  };
}

export function requiredSecrets(cfg: RefillConfig): string[] {
  const missing: string[] = [];
  if (!cfg.stripeKey) missing.push("STRIPE_PAYOUT_KEY or STRIPE_LIVE_SECRET_KEY (restricted key with crypto payout / outbound-transfer permission)");
  if (!cfg.stripeFinancialAccount) missing.push("STRIPE_FINANCIAL_ACCOUNT (Treasury/financial account id that holds USD or USDC)");
  if (!cfg.stripePayoutMethod) missing.push("STRIPE_CRYPTO_PAYOUT_METHOD (crypto wallet payout method / cwa_… for the sponsor 0x on Base or Ethereum)");
  if (!cfg.squidIntegratorId) missing.push("SQUID_INTEGRATOR_ID (request at docs.squidrouter.com)");
  if (!cfg.dryRun && !cfg.sendSourceTx) missing.push("SPONSOR_KEY_MAINNET (signs the Squid USDC→USDFC swap from the same 0x on the source chain; also needs a little source-chain gas)");
  return missing;
}

export function planRefill(input: {
  sponsor: Address;
  sponsorUsdfc: bigint;
  sourceUsdc: bigint;
  threshold: bigint;
  target: bigint;
  maxUsdc: bigint;
  dryRun: boolean;
  missing: string[];
}): RefillPlan {
  const needed = input.sponsorUsdfc >= input.target ? 0n : input.target - input.sponsorUsdfc;
  let payout = 0n;
  let action: "skip" | "refill" = "skip";
  let reason: string;
  if (input.sponsorUsdfc >= input.threshold) {
    reason = "sponsor USDFC is at or above the threshold";
  } else {
    payout = needed < input.maxUsdc ? needed : input.maxUsdc;
    if (payout <= 0n) {
      reason = "below threshold but computed payout is zero";
    } else {
      action = "refill";
      reason = input.dryRun
        ? "below threshold; dry-run would pay out up to max-per-run and swap to USDFC"
        : "below threshold; would pay out and swap to USDFC";
    }
  }
  return {
    dryRun: input.dryRun,
    sponsor: input.sponsor,
    sponsorUsdfc: formatUnits(input.sponsorUsdfc, 18),
    sourceUsdc: formatUnits(input.sourceUsdc, 6),
    thresholdUsdfc: formatUnits(input.threshold, 18),
    targetUsdfc: formatUnits(input.target, 18),
    maxUsdcPerRun: formatUnits(input.maxUsdc, 6),
    neededUsdfc: formatUnits(needed, 18),
    payoutUsdc: formatUnits(payout, 6),
    action,
    reason,
    missing: input.missing,
  };
}

async function jsonRpc(url: string, method: string, params: unknown[], fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? method);
  return body.result;
}

export async function erc20Balance(rpc: string, token: Address, owner: Address, decimals: number, fetchImpl: typeof fetch): Promise<bigint> {
  const data = `${ERC20_BALANCE}${owner.slice(2).toLowerCase().padStart(64, "0")}`;
  const raw = (await jsonRpc(rpc, "eth_call", [{ to: token, data }, "latest"], fetchImpl)) as string;
  return BigInt(raw || "0x0");
}

export async function quoteSquid(
  cfg: RefillConfig,
  fromAddress: Address,
  fromAmountUsdc: bigint,
): Promise<{ toAmount?: string; requestId?: string; transactionRequest?: { target?: Address; data?: Hex; value?: string } }> {
  if (!cfg.squidIntegratorId) throw new Error("SQUID_INTEGRATOR_ID is not set");
  const fetchImpl = cfg.fetch ?? fetch;
  const res = await fetchImpl(SQUID_ROUTE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-integrator-id": cfg.squidIntegratorId },
    body: JSON.stringify({
      fromAddress,
      fromChain: String(cfg.sourceChainId),
      fromToken: cfg.sourceUsdc,
      fromAmount: fromAmountUsdc.toString(),
      toChain: String(FILECOIN_MAINNET),
      toToken: cfg.usdfc,
      toAddress: cfg.sponsor,
    }),
  });
  const requestId = res.headers.get("x-request-id") ?? undefined;
  const body = (await res.json()) as { route?: { estimate?: { toAmount?: string }; transactionRequest?: { target?: Address; data?: Hex; value?: string } }; message?: string };
  if (!res.ok) throw new Error(body.message ?? `squid route HTTP ${res.status}`);
  return { toAmount: body.route?.estimate?.toAmount, requestId, transactionRequest: body.route?.transactionRequest };
}

/** Stripe v2 money-management outbound transfer of USDC to a pre-registered crypto wallet payout method. */
/** Squid's router (same address on its EVM chains); override with REFILL_SQUID_ROUTERS (comma-separated). */
export const SQUID_ROUTERS = (process.env.REFILL_SQUID_ROUTERS ?? "0xce16F69375520ab01377ce7B88f5BA8C48F8D666").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
const MAX_SQUID_NATIVE_WEI = 10n ** 16n; // 0.01 ETH: bridge/gas fee only

export function assertSquidTx(tx: { target?: string; value?: string | number | bigint }): void {
  if (!tx.target || !SQUID_ROUTERS.includes(String(tx.target).toLowerCase())) throw new Error(`refusing Squid tx to unexpected target ${tx.target}`);
  if (tx.value != null && BigInt(tx.value) > MAX_SQUID_NATIVE_WEI) throw new Error(`refusing Squid tx with native value ${tx.value}`);
}

export async function createStripeUsdcPayout(cfg: RefillConfig, amountUsdc: bigint): Promise<string> {
  if (!cfg.stripeKey || !cfg.stripeFinancialAccount || !cfg.stripePayoutMethod) throw new Error("Stripe payout secrets are not set");
  if (cfg.dryRun) throw new Error("refusing Stripe payout in dry-run");
  const fetchImpl = cfg.fetch ?? fetch;
  const res = await fetchImpl("https://api.stripe.com/v2/money_management/outbound_transfers", {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.stripeKey}`,
      "stripe-version": STRIPE_PAYOUTS_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: { financial_account: cfg.stripeFinancialAccount, currency: "usdc" },
      to: { payout_method: cfg.stripePayoutMethod, currency: "usdc" },
      amount: { value: Number(amountUsdc), currency: "usdc" },
    }),
  });
  const body = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok || !body.id) throw new Error(body.error?.message ?? `Stripe outbound transfer HTTP ${res.status}`);
  return body.id;
}

export async function postAlert(url: string | undefined, report: RefillReport, fetchImpl: typeof fetch): Promise<string | undefined> {
  if (!url) return undefined;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `USDFC refill ${report.action}${report.dryRun ? " (dry-run)" : ""}: ${report.reason}. sponsor=${report.sponsorUsdfc} USDFC, payout=${report.payoutUsdc} USDC.`, report }),
  });
  return res.ok ? `alert ${res.status}` : `alert failed ${res.status}`;
}

export async function runRefill(cfg: RefillConfig): Promise<RefillReport> {
  const fetchImpl = cfg.fetch ?? fetch;
  const [sponsorUsdfc, sourceUsdc] = await Promise.all([
    erc20Balance(cfg.filecoinRpc, cfg.usdfc, cfg.sponsor, 18, fetchImpl).catch(() => 0n),
    erc20Balance(cfg.sourceRpc, cfg.sourceUsdc, cfg.sponsor, 6, fetchImpl).catch(() => 0n),
  ]);
  const plan = planRefill({
    sponsor: cfg.sponsor,
    sponsorUsdfc,
    sourceUsdc,
    threshold: parseUnits(cfg.thresholdUsdfc, 18),
    target: parseUnits(cfg.targetUsdfc, 18),
    maxUsdc: parseUnits(cfg.maxUsdcPerRun, 6),
    dryRun: cfg.dryRun,
    missing: requiredSecrets(cfg),
  });
  const report: RefillReport = { ...plan, sponsor: cfg.sponsor };
  const payout = parseUnits(plan.payoutUsdc, 6);
  if (plan.action === "refill" && payout > 0n) {
    try {
      if (cfg.squidIntegratorId) {
        const quote = await quoteSquid(cfg, cfg.sponsor, payout);
        report.squidQuote = { toAmount: quote.toAmount, requestId: quote.requestId };
        if (!cfg.dryRun && sourceUsdc >= payout && cfg.sendSourceTx && quote.transactionRequest?.target && quote.transactionRequest.data) {
          // Never sign third-party calldata blindly: only the known Squid router, and at most a small native fee.
          assertSquidTx(quote.transactionRequest);
          report.squidTx = await cfg.sendSourceTx({
            to: quote.transactionRequest.target,
            data: quote.transactionRequest.data,
            value: quote.transactionRequest.value ? BigInt(quote.transactionRequest.value) : 0n,
          });
          report.reason = "swapped source USDC to Filecoin USDFC";
        }
      }
      if (!cfg.dryRun && sourceUsdc < payout) {
        report.stripePayoutId = await createStripeUsdcPayout(cfg, payout);
        report.reason = "Stripe USDC payout submitted; the next run will Squid-swap once the USDC is visible on the source chain";
      }
    } catch (error) {
      report.reason = `${plan.reason}; squid/payout: ${error instanceof Error ? error.message : error}`;
    }
  }
  report.alert = await postAlert(cfg.alertWebhook, report, fetchImpl).catch((error) => `alert error: ${error instanceof Error ? error.message : error}`);
  return report;
}

function redact(report: RefillReport): RefillReport {
  return report;
}

if (!process.env.VITEST && process.argv[1]?.endsWith("refill-usdfc.ts")) {
  const cfg = configFromEnv();
  if (!cfg.dryRun && process.env.SPONSOR_KEY_MAINNET) {
    const { createWalletClient, http } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { base, mainnet } = await import("viem/chains");
    const key = process.env.SPONSOR_KEY_MAINNET as Hex;
    const account = privateKeyToAccount(key);
    const chain = cfg.sourceChainId === 8453 ? base : cfg.sourceChainId === 1 ? mainnet : undefined;
    if (!chain) throw new Error(`no viem chain configured for sourceChainId ${cfg.sourceChainId}`);
    const wallet = createWalletClient({ account, chain, transport: http(cfg.sourceRpc) });
    cfg.sendSourceTx = async (tx) => wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n, account, chain });
  }
  const report = await runRefill(cfg);
  console.log(JSON.stringify(redact(report), null, 2));
  if (!cfg.dryRun && report.action === "refill" && report.missing.length) process.exit(2);
}
