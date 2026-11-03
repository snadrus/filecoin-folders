/** /person/?id=<wallet>: view someone's FiPerson profile (name, avatar, bio, shared clubs, how to reach them). */
import "../stale-chunks.js";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "../identity/identity.css";
import { avatarHtml, cachedIdentity, escapeHtml as esc, isAddress } from "fiperson/view";
import { details } from "fiperson/people";

const root = document.querySelector<HTMLElement>("#person-app")!;

export function personPageHtml(id: string): string {
  const d = details(id);
  if (!d) return `<section class="card"><p data-testid="person-missing">No person here. The link needs <code>?id=</code> and a wallet address.</p></section>`;
  const slack = d.contact?.channel === "slack" ? d.contact : null;
  const slackLink = slack ? `https://app.slack.com/client/${encodeURIComponent(slack.team)}/${encodeURIComponent(slack.user)}` : "";
  return `<section class="card" data-testid="person-page">
    <div class="preview">${avatarHtml(cachedIdentity(d.address), 64)}<span><strong data-testid="person-name" style="font-size:20px">${esc(d.name)}</strong><small>${esc(d.address)}</small></span></div>
    ${d.hasIdentity ? "" : `<p class="note">This wallet has not set up a FiPerson identity, so it shows a guest name.</p>`}
    ${d.bio ? `<p data-testid="person-bio" style="margin:0">${esc(d.bio)}</p>` : ""}
    <div><div class="field">Clubs you share</div><p class="note" data-testid="person-clubs">${d.sharedClubs.length ? d.sharedClubs.map(esc).join(" · ") : `None found. <a href="../identity/#clubs">Find all my Clubs</a>`}</p></div>
    <div><div class="field">Notifications</div><p class="note" data-testid="person-contact">${slack ? `${esc(d.contactLabel)} · member ${esc(slack.user)} · <a href="${esc(slackLink)}" target="_blank" rel="noopener">Open in Slack</a>` : "No notification contact set."}</p></div>
  </section>`;
}

async function boot(): Promise<void> {
  const id = (new URLSearchParams(location.search).get("id") || "").toLowerCase();
  const back = document.referrer && new URL(document.referrer).origin === location.origin ? document.referrer : "../";
  const frame = (body: string) => (root.innerHTML = `<div class="wrap"><a class="back" href="${esc(back)}">← Back</a><header><h1>Person</h1></header>${body}</div>`);
  frame(personPageHtml(id));
  if (!isAddress(id)) return;
  const io = import.meta.env.VITE_E2E === "1" ? (await import("../identity/mock-io.js")).createMockIdentityIO() : (await import("../identity/live-io.js")).createLiveIdentityIO();
  await io.load(id).catch(() => null); // refreshes the shared identity cache
  frame(personPageHtml(id));
}
void boot();
