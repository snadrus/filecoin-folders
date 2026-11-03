import { cachedIdentity, escapeHtml as esc, personChipHtml, shortAddress, type ResolvedIdentity } from "fiperson/view";
import { getAddress, isAddress, type Address } from "viem";
import { onWalletPrompts, isUserRejection, type WalletPrompt } from "../wallet-prompts.js";
import { checkBlob, encodeBlob, parseBlob, type ClubView, type RemovalBlob } from "./core.js";
import type { ClubIO } from "./io.js";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const DAY = 86_400;

export interface PageOptions {
  /** Live resolver (chain + piece); omitted in tests so only cache/guest names are used. */
  resolve?: (address: string) => Promise<ResolvedIdentity>;
  now?: () => number;
}

export class ClubPage {
  private me: Address | null = null;
  private clubs: ClubView[] = [];
  private open: bigint | null = null;
  private prompts: WalletPrompt[] = [];
  private busy = false;
  private error = "";
  private notice = "";
  private blob: RemovalBlob | null = null; // step-1 output to share
  private imported: { blob: RemovalBlob; problems: string[] } | null = null;
  private names = new Map<string, ResolvedIdentity>();

  constructor(
    private root: HTMLElement,
    private io: ClubIO,
    private opts: PageOptions = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Math.floor(Date.now() / 1000);
  }

  async start(): Promise<void> {
    onWalletPrompts((p) => {
      this.prompts = p;
      this.renderToasts();
    });
    this.root.addEventListener("click", (e) => void this.onClick(e));
    this.root.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.onSubmit(e.target as HTMLFormElement);
    });
    this.me = await this.io.peek();
    if (this.me) await this.refresh();
    this.render();
  }

  private person(addr: string): ResolvedIdentity {
    const key = addr.toLowerCase();
    let p = this.names.get(key);
    if (!p) {
      p = cachedIdentity(addr);
      this.names.set(key, p);
      this.opts.resolve?.(addr).then((r) => {
        this.names.set(key, r);
        this.render();
      }, () => {});
    }
    return p;
  }

  private club(): ClubView | undefined {
    return this.clubs.find((c) => c.id === this.open);
  }

  private async refresh(): Promise<void> {
    if (!this.me) return;
    this.clubs = await this.io.listClubs(this.me);
  }

  private async run(fn: () => Promise<void>, ok?: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    this.notice = "";
    this.render();
    try {
      await fn();
      await this.refresh();
      if (ok) this.notice = ok;
    } catch (e) {
      this.error = isUserRejection(e) ? "Cancelled in your wallet." : ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private addr(form: HTMLFormElement): Address {
    const v = (new FormData(form).get("address") as string | null)?.trim() ?? "";
    if (!isAddress(v)) throw new Error("Enter a valid 0x wallet address.");
    return getAddress(v);
  }

  private async onSubmit(form: HTMLFormElement): Promise<void> {
    const kind = form.dataset.form;
    const c = this.club();
    if (kind === "create") {
      const name = (new FormData(form).get("name") as string).trim();
      if (!name) return;
      await this.run(async () => {
        this.open = await this.io.createClub(name);
      }, `Created “${name}”.`);
    } else if (kind === "add-member" && c) {
      await this.run(() => this.io.addMember(c.id, this.addr(form)), "Member added.");
    } else if (kind === "add-admin" && c) {
      await this.run(() => this.io.addAdmin(c.id, this.addr(form)), "Admin added.");
    } else if (kind === "import" && c) {
      const text = (new FormData(form).get("blob") as string) ?? "";
      this.error = "";
      try {
        const blob = parseBlob(text);
        this.imported = { blob, problems: checkBlob(blob, { chainId: this.io.chainId, contract: this.io.contract, club: c, me: this.me!, now: this.now() }) };
      } catch (e) {
        this.imported = null;
        this.error = (e as Error).message;
      }
      this.render();
    }
  }

  private async onClick(e: Event): Promise<void> {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!el) return;
    const a = el.dataset.action;
    const who = el.dataset.who as Address | undefined;
    const c = this.club();
    if (a === "connect")
      await this.run(async () => {
        this.me = await this.io.connect();
      });
    else if (a === "open") {
      this.open = BigInt(el.dataset.id!);
      this.blob = this.imported = null;
      this.render();
    } else if (a === "back") {
      this.open = null;
      this.render();
    } else if (a === "remove-member" && c && who) await this.run(() => this.io.removeMember(c.id, who), "Member removed.");
    else if (a === "remove-admin" && c && who) await this.run(() => this.io.removeAdmin(c.id, who), "Admin removed.");
    else if (a === "sign-removal" && c && who)
      await this.run(async () => {
        const deadline = BigInt(this.now() + 7 * DAY);
        const sig1 = await this.io.signRemoval(this.me!, c, who, deadline, 1);
        this.blob = { kind: "ficlub/remove-admin", v: 1, chainId: this.io.chainId, contract: this.io.contract, clubId: c.id.toString(), clubName: c.name, target: who, nonce: c.nonce.toString(), deadline: deadline.toString(), signer1: this.me!, sig1 };
      }, "Step 1 signed. Send this to another admin.");
    else if (a === "copy-blob" && this.blob) {
      await navigator.clipboard?.writeText(encodeBlob(this.blob)).catch(() => {});
      this.notice = "Copied.";
      this.render();
    } else if (a === "download-blob" && this.blob) {
      const url = URL.createObjectURL(new Blob([encodeBlob(this.blob)], { type: "application/json" }));
      const link = Object.assign(document.createElement("a"), { href: url, download: `ficlub-${this.blob.clubId}-remove-${this.blob.target.slice(0, 8)}.json` });
      link.click();
      URL.revokeObjectURL(url);
    } else if (a === "cosign" && c && this.imported && !this.imported.problems.length) {
      const blob = this.imported.blob;
      await this.run(async () => {
        const sig2 = await this.io.signRemoval(this.me!, c, blob.target, BigInt(blob.deadline), 2);
        await this.io.submitRemoval(blob, sig2);
        this.imported = null;
      }, "Admin removed with two signatures.");
    } else if (a === "load-file") {
      const input = this.root.querySelector<HTMLInputElement>("[data-testid=ficlub-import-file]");
      const ta = this.root.querySelector<HTMLTextAreaElement>("[data-testid=ficlub-import-text]");
      const f = input?.files?.[0];
      if (f && ta) ta.value = await f.text();
    }
  }

  private chip(addr: string, tags: string[]): string {
    const p = this.person(addr);
    const me = this.me && same(addr, this.me) ? ' <span class="tag you">you</span>' : "";
    return `<span class="who">${personChipHtml({ address: addr, displayName: p.displayName, avatar: p.avatar }, 28)}<small title="${esc(addr)}">${esc(shortAddress(addr))}</small>${me}${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</span>`;
  }

  private render(): void {
    const banner =
      this.io.mode === "mock"
        ? `<p class="blocked" data-testid="ficlub-not-deployed">FiClub contract not deployed yet — this page runs on an in-memory demo backend in this browser. Nothing is written on chain.</p>`
        : "";
    let body: string;
    if (!this.me) body = `<div class="card"><p>Connect a wallet to see your clubs.</p><button class="primary" data-action="connect" data-testid="ficlub-connect">Connect wallet</button></div>`;
    else if (this.club()) body = this.renderClub(this.club()!);
    else body = this.renderList();
    const status = `${this.busy ? `<p class="note" data-testid="ficlub-busy">Working…</p>` : ""}${this.error ? `<p class="error" data-testid="ficlub-error">${esc(this.error)}</p>` : ""}${this.notice ? `<p class="ok" data-testid="ficlub-notice">${esc(this.notice)}</p>` : ""}`;
    this.root.innerHTML = `<div class="wrap"><a class="back" href="../">← FiFolders</a><h1>FiClub</h1><p class="lede">On-chain groups: each club has a members list and an admins list. Admins add and remove people; removing an admin from a club with 3+ admins needs two admin signatures.</p>${banner}${status}${body}</div><div class="toasts" aria-live="polite"></div>`;
    this.renderToasts();
  }

  private renderList(): string {
    const rows = this.clubs
      .map((c) => {
        const role = c.admins.some((a) => same(a, this.me!)) ? "admin" : "member";
        return `<li><button class="row" data-action="open" data-id="${c.id}" data-testid="ficlub-club"><strong>${esc(c.name)}</strong><span class="tag">${role}</span><small>${c.members.length} members · ${c.admins.length} admins</small></button></li>`;
      })
      .join("");
    return `<div class="card"><h2>Your clubs</h2>${rows ? `<ul class="list">${rows}</ul>` : `<p class="note" data-testid="ficlub-empty">You are not in any club yet.</p>`}
      <form data-form="create" class="inline"><input name="name" placeholder="New club name" maxlength="80" data-testid="ficlub-name" required /><button class="primary" data-testid="ficlub-create" ${this.busy ? "disabled" : ""}>Create club</button></form>
      <p class="note">Creating a club costs gas (~0.02 FIL on Calibration). You become its first admin and member.</p></div>`;
  }

  private renderClub(c: ClubView): string {
    const iAdmin = c.admins.some((a) => same(a, this.me!));
    const many = c.admins.length > 2;
    const dis = this.busy ? "disabled" : "";
    const members = c.members
      .map((m) => `<li>${this.chip(m, [])}${iAdmin ? `<button class="text" data-action="remove-member" data-who="${m}" data-testid="ficlub-remove-member" ${dis}>Remove</button>` : ""}</li>`)
      .join("");
    const admins = c.admins
      .map((m) => {
        let btn = "";
        if (iAdmin && !many && c.admins.length > 1) btn = `<button class="text" data-action="remove-admin" data-who="${m}" data-testid="ficlub-remove-admin" ${dis}>${same(m, this.me!) ? "Step down" : "Remove admin"}</button>`;
        if (iAdmin && many) btn = `<button class="text" data-action="sign-removal" data-who="${m}" data-testid="ficlub-sign-removal" ${dis}>Remove admin — step 1: sign</button>`;
        return `<li>${this.chip(m, [])}${btn}</li>`;
      })
      .join("");
    const rule = many
      ? `This club has ${c.admins.length} admins: removing one needs signatures from 2 different admins (the admin being removed may be one of them). Step 1 makes a signature to share; the second admin imports it, co-signs and submits.`
      : c.admins.length === 1
        ? "The last admin can't be removed. Add another admin first."
        : "With 2 admins, either admin can remove the other or step down directly.";
    const share = this.blob
      ? `<div class="share" data-testid="ficlub-blob"><h3>Step 1 signed — share with a second admin</h3><p class="note">Removes ${esc(shortAddress(this.blob.target))} from “${esc(c.name)}”. Valid until ${new Date(Number(this.blob.deadline) * 1000).toLocaleString()}, and only while no other admin removal happens first.</p><textarea readonly rows="6" data-testid="ficlub-blob-text">${esc(encodeBlob(this.blob))}</textarea><div class="inline"><button data-action="copy-blob" data-testid="ficlub-copy">Copy</button><button data-action="download-blob" data-testid="ficlub-download">Download .json</button></div></div>`
      : "";
    const imp = this.imported
      ? `<div class="share" data-testid="ficlub-import-review"><h3>Review removal</h3><p>Remove admin ${this.chip(this.imported.blob.target, [])} from “${esc(c.name)}”, first signed by ${this.chip(this.imported.blob.signer1, [])}.</p>${
          this.imported.problems.length
            ? `<ul class="error" data-testid="ficlub-import-problems">${this.imported.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
            : `<p class="note">You'll sign (free), then submit both signatures (gas ~0.01 FIL).</p><button class="primary" data-action="cosign" data-testid="ficlub-cosign" ${dis}>Co-sign and submit removal</button>`
        }</div>`
      : "";
    const adminTools = iAdmin
      ? `<form data-form="add-member" class="inline"><input name="address" placeholder="0x… wallet to add as member" data-testid="ficlub-member-input" /><button data-testid="ficlub-add-member" ${dis}>Add member</button></form>`
      : "";
    const adminTools2 = iAdmin
      ? `<form data-form="add-admin" class="inline"><input name="address" placeholder="0x… wallet to make admin" data-testid="ficlub-admin-input" /><button data-testid="ficlub-add-admin" ${dis}>Add admin</button></form>
        <p class="note">${esc(rule)}</p>${share}
        ${many ? `<form data-form="import" class="importer"><h3>Import removal signature</h3><textarea name="blob" rows="4" placeholder="Paste the step-1 JSON from another admin" data-testid="ficlub-import-text"></textarea><div class="inline"><input type="file" accept=".json,application/json,text/plain" data-testid="ficlub-import-file" /><button type="button" data-action="load-file">Load file</button><button data-testid="ficlub-import">Check signature</button></div></form>${imp}` : ""}`
      : `<p class="note">You're a member. Only admins can change this club.</p>`;
    return `<button class="text" data-action="back" data-testid="ficlub-back">← All clubs</button>
      <div class="card" data-testid="ficlub-detail"><h2>${esc(c.name)} <small>#${c.id}</small></h2>
      <section><h3>Members (${c.members.length})</h3><ul class="people" data-testid="ficlub-members">${members}</ul>${adminTools}</section>
      <section><h3>Admins (${c.admins.length})</h3><ul class="people" data-testid="ficlub-admins">${admins}</ul>${adminTools2}</section></div>`;
  }

  private renderToasts(): void {
    const host = this.root.querySelector<HTMLElement>(".toasts");
    if (!host) return;
    host.innerHTML = this.prompts
      .map((p) =>
        p.state === "waiting"
          ? `<div class="toast" data-testid="wallet-prompt"><span class="spinner"></span>Check your wallet — <strong>${esc(p.intent.title)}</strong> <small>${esc([p.intent.purpose, p.intent.cost].filter(Boolean).join(" · "))}</small></div>`
          : `<div class="toast" data-testid="wallet-prompt" data-state="rejected">Rejected — ${esc(p.intent.title)} <button type="button" data-retry="${p.id}">Retry</button><button type="button" data-cancel="${p.id}">Cancel</button></div>`,
      )
      .join("");
    for (const p of this.prompts) {
      host.querySelector(`[data-retry="${p.id}"]`)?.addEventListener("click", () => p.retry());
      host.querySelector(`[data-cancel="${p.id}"]`)?.addEventListener("click", () => p.cancel());
    }
  }
}
