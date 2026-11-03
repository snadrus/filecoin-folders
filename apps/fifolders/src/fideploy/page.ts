import { createPublicClient, custom, getAddress, http, type Address, type Hex, type PublicClient } from "viem";
import { onWalletPrompts, watchWalletPrompts, withWalletIntent, INTENTS, type WalletPrompt } from "../wallet-prompts.js";
import { discoverWallets } from "../eip6963.js";
import { ARTIFACTS, chainInfo, codeStatus, deployData, deploymentsJson, formatCost, loadPrivate, savePrivate, type ChainInfo, type CodeStatus, type ContractName, type DeploymentRecord } from "./core.js";

type Provider = { request(args: { method: string; params?: unknown }): Promise<unknown>; on?: (e: string, f: (...a: unknown[]) => void) => void };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const DEPLOYABLE = ["FolderRegistryV2", "FiClub"] as const;
type Deployable = (typeof DEPLOYABLE)[number];
const PURPOSE: Record<ContractName, string> = {
  FolderRegistryV2: "FiFolders drive pointers (one head per folder volume)",
  FiClub: "on-chain groups: members, admins, 2-signature admin removal",
  SessionKeyRegistry: "Filecoin Pay session keys (shared, canonical; not deployed here)",
};

interface Row { name: ContractName; address?: Address; status: CodeStatus | "unknown"; cost?: string; error?: string }

export interface DeployPageOptions { walletConnect?: () => Promise<Provider> }

export class DeployPage {
  private provider: Provider | null = null;
  private me: Address | null = null;
  private chainId = 314159;
  private customRpc = "";
  private rows: Row[] = [];
  private records: DeploymentRecord[] = [];
  private prompts: WalletPrompt[] = [];
  private busy = "";
  private error = "";
  private mainnetAck = false;
  private seq = 0;

  constructor(private root: HTMLElement, private opts: DeployPageOptions = {}) {}

  async start(): Promise<void> {
    onWalletPrompts((p) => {
      this.prompts = p;
      this.renderToasts();
    });
    this.root.addEventListener("click", (e) => void this.onClick(e));
    this.root.addEventListener("change", (e) => void this.onChange(e));
    await this.refresh();
  }

  private get chain(): ChainInfo {
    return chainInfo(this.chainId, this.customRpc);
  }

  private client(): PublicClient {
    const transport = this.customRpc ? http(this.customRpc) : this.provider ? custom(this.provider) : http(this.chain.rpc);
    return createPublicClient({ transport }) as PublicClient;
  }

  private async connect(kind: "injected" | "walletconnect"): Promise<void> {
    this.error = "";
    let raw: Provider | undefined;
    if (kind === "walletconnect") {
      if (!this.opts.walletConnect) throw new Error("WalletConnect is not configured.");
      raw = await this.opts.walletConnect();
    } else {
      const wallets = await discoverWallets().catch(() => []);
      raw = (wallets[0]?.provider as Provider | undefined) ?? (window as unknown as { ethereum?: Provider }).ethereum;
    }
    if (!raw) throw new Error("No browser wallet found. Install MetaMask (Ledger works through MetaMask) or use WalletConnect.");
    this.provider = watchWalletPrompts(raw);
    const accounts = (await withWalletIntent(INTENTS.connect, () => this.provider!.request({ method: "eth_requestAccounts" }))) as string[];
    if (!accounts?.[0]) throw new Error("The wallet returned no account.");
    this.me = getAddress(accounts[0]);
    this.chainId = Number(await this.provider.request({ method: "eth_chainId" }));
    raw.on?.("chainChanged", (id) => {
      this.chainId = Number(id);
      void this.refresh();
    });
    raw.on?.("accountsChanged", (a) => {
      const list = a as string[];
      this.me = list?.[0] ? getAddress(list[0]) : null;
      void this.refresh();
    });
  }

  private async refresh(): Promise<void> {
    const seq = ++this.seq; // a slower earlier read (e.g. the pre-connect public RPC) must not overwrite this one
    if (this.provider && !this.customRpc) this.chainId = Number(await this.provider.request({ method: "eth_chainId" }).catch(() => this.chainId));
    if (this.customRpc && !this.provider) this.chainId = await this.client().getChainId().catch(() => this.chainId);
    this.records = loadPrivate(this.chainId);
    const client = this.client();
    const names: ContractName[] = ["FolderRegistryV2", "FiClub", "SessionKeyRegistry"];
    if (seq !== this.seq) return;
    this.rows = names.map((name) => ({ name, address: this.chain.known[name], status: "unknown" as const }));
    this.render();
    let gasPrice = 0n;
    try {
      gasPrice = await client.getGasPrice();
    } catch {
      /* estimate stays blank */
    }
    await Promise.all(
      this.rows.map(async (row) => {
        try {
          const expected = row.name === "SessionKeyRegistry" ? undefined : ARTIFACTS[row.name].deployedBytecode;
          row.status = row.address ? codeStatus(await client.getCode({ address: row.address }), expected) : "absent";
          if (row.name !== "SessionKeyRegistry" && this.me && gasPrice) {
            const data = deployData(row.name, this.me, this.chain.known.SessionKeyRegistry);
            row.cost = formatCost(await client.estimateGas({ account: this.me, data }), gasPrice);
          }
        } catch (e) {
          row.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
        }
      }),
    );
    if (seq === this.seq) this.render();
  }

  private async deploy(name: Deployable): Promise<void> {
    if (!this.provider || !this.me) throw new Error("Connect a wallet first.");
    if (!this.chain.testnet && !this.mainnetAck) throw new Error("Tick “I understand this spends real FIL” to deploy on mainnet.");
    const skr = this.chain.known.SessionKeyRegistry;
    const data = deployData(name, this.me, skr);
    const row = this.rows.find((r) => r.name === name);
    const intent = { title: `Deploy ${name}`, purpose: `${PURPOSE[name]} on ${this.chain.name}, owned by your wallet`, cost: row?.cost ? `${row.cost} gas` : "gas", logged: true };
    this.busy = name;
    this.render();
    try {
      const hash = (await withWalletIntent(intent, () => this.provider!.request({ method: "eth_sendTransaction", params: [{ from: this.me, data }] }))) as Hex;
      const receipt = await this.client().waitForTransactionReceipt({ hash, timeout: 600_000 });
      if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${name} deploy failed on chain (${hash}).`);
      const code = await this.client().getCode({ address: receipt.contractAddress });
      const rec: DeploymentRecord = {
        contract: name,
        address: getAddress(receipt.contractAddress),
        txHash: hash,
        block: Number(receipt.blockNumber),
        deployer: this.me,
        ...(name === "FolderRegistryV2" ? { sessionKeyRegistry: skr } : {}),
        verified: codeStatus(code, ARTIFACTS[name].deployedBytecode),
        date: new Date().toISOString().slice(0, 10),
      };
      this.records = savePrivate(this.chainId, rec);
    } finally {
      this.busy = "";
    }
    this.render();
  }

  private async onClick(e: Event): Promise<void> {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!el) return;
    const action = el.dataset.action!;
    try {
      if (action === "connect") await this.connect("injected"), await this.refresh();
      else if (action === "walletconnect") await this.connect("walletconnect"), await this.refresh();
      else if (action === "deploy") await this.deploy(el.dataset.name as Deployable);
      else if (action === "copy") await navigator.clipboard.writeText(this.json());
      else if (action === "download") {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([this.json()], { type: "application/json" }));
        a.download = `deployments-${this.chainId}.json`;
        a.click();
      } else if (action === "switch") {
        const id = Number(el.dataset.chain);
        if (this.provider) await this.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${id.toString(16)}` }] });
        this.chainId = id;
        this.customRpc = "";
        await this.refresh();
      }
    } catch (err) {
      this.busy = "";
      this.error = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      this.render();
    }
  }

  private async onChange(e: Event): Promise<void> {
    const t = e.target as HTMLInputElement;
    if (t.dataset.testid === "fideploy-rpc") {
      this.customRpc = t.value.trim();
      await this.refresh();
    } else if (t.dataset.testid === "fideploy-mainnet-ack") {
      this.mainnetAck = t.checked;
      this.render();
    }
  }

  private json(): string {
    return deploymentsJson(this.chain, this.records);
  }

  private render(): void {
    const c = this.chain;
    const badge = (s: Row["status"]) =>
      ({ match: `<span class="tag ok">deployed · bytecode match</span>`, different: `<span class="tag warn">code differs from this build</span>`, absent: `<span class="tag">not deployed</span>`, unknown: `<span class="tag"><span class="spinner"></span> checking</span>` })[s];
    const rows = this.rows
      .map((r) => {
        const status = r.name === "SessionKeyRegistry" && r.status === "match" ? `<span class="tag ok">present (canonical)</span>` : badge(r.status);
        const deployable = r.name !== "SessionKeyRegistry";
        const blocked = r.name === "FolderRegistryV2" && !c.known.SessionKeyRegistry;
        const link = r.address && c.explorer ? `<a href="${c.explorer}${r.address}" target="_blank" rel="noopener">${short(r.address)}</a>` : r.address ? short(r.address) : "";
        const btn = deployable
          ? `<button class="primary" data-action="deploy" data-name="${r.name}" data-testid="fideploy-deploy-${r.name}" ${!this.me || this.busy || blocked || (!c.testnet && !this.mainnetAck) ? "disabled" : ""}>${this.busy === r.name ? `<span class="spinner"></span> Deploying…` : r.status === "match" && c.testnet ? "Deploy my own test instance" : "Deploy"}</button>`
          : "";
        return `<li class="contract" data-testid="fideploy-row-${r.name}"><div><h3>${r.name}</h3><small>${esc(PURPOSE[r.name])}</small><div class="meta">${status} ${link} ${r.cost ? `<span class="cost">est. ${r.cost}</span>` : deployable && !this.me ? `<span class="cost">connect to estimate</span>` : ""}</div>${blocked ? `<p class="note">Needs a SessionKeyRegistry on this chain first.</p>` : ""}${r.error ? `<p class="err">${esc(r.error)}</p>` : ""}</div>${btn}</li>`;
      })
      .join("");
    const recs = this.records.length
      ? `<div class="card" data-testid="fideploy-records"><h2>Deployments from this browser</h2><ul class="list">${this.records.map((r) => `<li>${r.contract} · ${c.explorer ? `<a href="${c.explorer}${r.address}" target="_blank" rel="noopener">${r.address}</a>` : r.address} · ${r.verified === "match" ? "✓ bytecode verified" : r.verified}</li>`).join("")}</ul>
        <pre data-testid="fideploy-json">${esc(this.json())}</pre><div class="inline"><button data-action="copy" data-testid="fideploy-copy">Copy JSON</button><button data-action="download" data-testid="fideploy-download">Download JSON</button></div><p class="note">Commit it as <code>deployments/&lt;network&gt;.json</code>.</p></div>`
      : "";
    const wallet = this.me
      ? `<p data-testid="fideploy-account">Connected <strong>${short(this.me)}</strong> on <strong>${esc(c.name)}</strong> (chain ${c.id})</p>`
      : `<div class="inline"><button class="primary" data-action="connect" data-testid="fideploy-connect">Connect wallet</button>${this.opts.walletConnect ? `<button data-action="walletconnect" data-testid="fideploy-wc">WalletConnect</button>` : ""}</div><p class="note">MetaMask, Ledger through MetaMask, or a mobile wallet via WalletConnect. Nothing is sent until you press Deploy.</p>`;
    const switcher = `<div class="inline chains">${[314159, 314].map((id) => `<button data-action="switch" data-chain="${id}" class="${id === c.id && !this.customRpc ? "on" : ""}" data-testid="fideploy-chain-${id}">${chainInfo(id).name}</button>`).join("")}<input data-testid="fideploy-rpc" placeholder="Custom RPC (devnet)" value="${esc(this.customRpc)}" /></div>`;
    const extras = c.testnet
      ? `<p class="note">Testnet: deploy a private instance to test against${c.faucet ? ` · <a href="${c.faucet}" target="_blank" rel="noopener" data-testid="fideploy-faucet">get test FIL</a>` : ""}.</p>`
      : `<label class="ack"><input type="checkbox" data-testid="fideploy-mainnet-ack" ${this.mainnetAck ? "checked" : ""}/> I understand this deploys on mainnet and spends real FIL from my wallet.</label>`;
    this.root.innerHTML = `<div class="wrap"><a class="back" href="../">← FiFolders</a><h1>FiDeploy</h1><p class="lede">Put the FiFolders contracts on a chain from your own wallet. Bytecode is this site's build (solc ${esc(ARTIFACTS.FiClub.compiler)}, deterministic), checked against the chain after deploying.</p>
      <div class="card">${wallet}${switcher}${extras}</div>${this.error ? `<p class="err" data-testid="fideploy-error">${esc(this.error)}</p>` : ""}
      <div class="card"><h2>Contracts on ${esc(c.name)}</h2><ul class="list">${rows}</ul></div>${recs}</div><div class="toasts" aria-live="polite"></div>`;
    this.renderToasts();
  }

  private renderToasts(): void {
    const host = this.root.querySelector<HTMLElement>(".toasts");
    if (!host) return;
    host.innerHTML = this.prompts
      .map((p) => (p.state === "waiting" ? `<div class="toast" data-testid="wallet-prompt"><span class="spinner"></span>Check your wallet — <strong>${esc(p.intent.title)}</strong> <small>${esc([p.intent.purpose, p.intent.cost].filter(Boolean).join(" · "))}</small></div>` : `<div class="toast" data-testid="wallet-prompt" data-state="rejected">Rejected — ${esc(p.intent.title)} <button type="button" data-retry="${p.id}">Retry</button><button type="button" data-cancel="${p.id}">Cancel</button></div>`))
      .join("");
    for (const p of this.prompts) {
      host.querySelector(`[data-retry="${p.id}"]`)?.addEventListener("click", () => p.retry());
      host.querySelector(`[data-cancel="${p.id}"]`)?.addEventListener("click", () => p.cancel());
    }
  }
}
