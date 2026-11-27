/** Deliver sponsor alert mail: Cloudflare Email Routing `send_email` binding first, then Resend. */

export interface OutgoingEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
}

export type MailChannel = "email-routing" | "resend";

export interface MailEnv {
  EMAIL?: { send: (message: unknown) => Promise<unknown> };
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  SPONSOR_ALERT_FROM?: string;
  fetch?: typeof fetch;
}

const RESEND_DEV_FROM = "FiFolders Sponsor <onboarding@resend.dev>";

function rawMime(msg: OutgoingEmail): string {
  const id = `<${crypto.randomUUID()}@scionbase.ai>`;
  const subject = /[^\x20-\x7E]/.test(msg.subject)
    ? `=?UTF-8?B?${btoa(unescape(encodeURIComponent(msg.subject)))}?=`
    : msg.subject;
  return [
    `From: ${msg.from}`,
    `To: ${msg.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    `Message-ID: ${id}`,
    `Date: ${new Date().toUTCString()}`,
    "",
    msg.text.replace(/\n/g, "\r\n"),
  ].join("\r\n");
}

async function sendViaRouting(binding: NonNullable<MailEnv["EMAIL"]>, msg: OutgoingEmail): Promise<void> {
  try {
    await binding.send({ from: msg.from, to: msg.to, subject: msg.subject, text: msg.text });
    return;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
    // Structured send is the current Email Service API. Fall back to the legacy EmailMessage MIME form.
    if (code && !code.startsWith("E_")) throw error;
    if (error instanceof TypeError || !code) {
      try {
        const specifier = "cloudflare" + ":" + "email";
        const { EmailMessage } = await import(/* @vite-ignore */ specifier) as { EmailMessage: new (from: string, to: string, raw: string) => unknown };
        await binding.send(new EmailMessage(msg.from, msg.to, rawMime(msg)));
        return;
      } catch (legacy) {
        throw error instanceof TypeError ? legacy : error;
      }
    }
    throw error;
  }
}

async function sendViaResend(env: MailEnv, msg: OutgoingEmail): Promise<void> {
  const key = env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  // Unverified domains cannot use an arbitrary From; onboarding@resend.dev works without a domain.
  const from = env.RESEND_FROM || RESEND_DEV_FROM;
  const fetchFn = env.fetch ?? fetch;
  const response = await fetchFn("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

export function mailerConfigured(env: MailEnv): boolean {
  return Boolean(env.EMAIL) || Boolean(env.RESEND_API_KEY);
}

export async function deliverAlertEmail(env: MailEnv, msg: OutgoingEmail): Promise<{ channel: MailChannel }> {
  if (env.EMAIL) {
    await sendViaRouting(env.EMAIL, msg);
    return { channel: "email-routing" };
  }
  if (env.RESEND_API_KEY) {
    await sendViaResend(env, msg);
    return { channel: "resend" };
  }
  throw new Error("no mailer: enable Cloudflare Email Routing send_email on scionbase.ai, or set RESEND_API_KEY");
}

export { RESEND_DEV_FROM };
