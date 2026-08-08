/**
 * Turning inbox rows into email (TDR §7.3).
 *
 * The same shape as `push.ts` and for the same reason: the sending is a `fetch`
 * in an edge function, and everything that can be got wrong is here, where a
 * test can read it without a mailbox.
 *
 * Three things this file decides:
 *
 *   * **What is worth an email at all.** Almost nothing is. Splitwise mails a
 *     person every time anybody buys a coffee, and the result is a filter rule.
 *     ADR-010 and TDR §7.3 allow a short list; `TEMPLATE_FOR_KIND` is that list
 *     written down, and a kind missing from it is a kind that never gets mailed
 *     no matter what the fanout is asked to do.
 *   * **What it says.** Nothing new. An email carries the same sentence as the
 *     inbox and the push, in the recipient's language, because it is the same
 *     notification arriving by a different door. What gets added is the chrome
 *     an email needs and a push has no room for: a button, why this arrived,
 *     and how to stop it.
 *   * **How to stop it.** One click, no login, no "manage preferences" page
 *     that asks who you are first. RFC 8058 requires the mailbox to be able to
 *     POST the unsubscribe URL itself, so that URL has to prove the address
 *     without a session — hence the signature rather than a bare `?email=`,
 *     which would let anybody unsubscribe anybody.
 *
 * `baaki://` links are rewritten to the web-lite group page. A deep link is
 * exactly right on a phone and dead in desktop webmail, and the person reading
 * a settlement mail at a laptop is the one most likely to be at a laptop.
 */

import { renderNotification, type NotificationFacts } from './render';
import { copyFor, interpolate } from './copy';

/**
 * The templates that exist. TDR §7.3 names six; these are the three with
 * something that produces them today. The other three — `otp-login`,
 * `group-invite`, `export-ready` — have no caller: Supabase Auth sends its own
 * OTP mail, invites are links rather than addresses, and export hands back a
 * signed URL in the same response. Adding renderers for them now would be
 * three untested code paths waiting for a feature.
 */
export type EmailTemplate = 'settlement-confirm' | 'digest' | 'nudge';

/**
 * Which notification kinds leave the building as mail.
 *
 * Deliberately not `expense_added` and its neighbours. Routine ledger activity
 * is the inbox's job and the push's job; mailing it is the mistake that trains
 * people to filter the sender.
 */
export const TEMPLATE_FOR_KIND: Readonly<Record<string, EmailTemplate>> = {
  settlement_initiated: 'settlement-confirm',
  settlement_confirm_request: 'settlement-confirm',
  digest_daily: 'digest',
  /**
   * A nudge is mailed only when the person has no live device — TDR §7.4. That
   * condition is not checked here; it is checked in SQL, where the tokens are.
   */
  nudge: 'nudge',
};

export function templateForKind(kind: string): EmailTemplate | null {
  return TEMPLATE_FOR_KIND[kind] ?? null;
}

/** Languages written right to left. Only the layout changes; the copy is copy. */
const RIGHT_TO_LEFT = new Set(['ar', 'he', 'fa', 'ur']);

export interface EmailableNotification {
  readonly id: string;
  readonly kind: string;
  /** English fallback stored on the row, used when the kind is unknown here. */
  readonly title: string;
  readonly body: string;
  readonly deepLink?: string | null;
  readonly facts?: NotificationFacts;
  readonly locale?: string | null;
  /** The recipient's address, already checked against the suppression list. */
  readonly to: string;
  /** Shown in the footer so the reason for the mail is on the mail. */
  readonly groupName?: string | null;
}

export interface BuiltEmail {
  readonly notificationId: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly template: EmailTemplate;
  /**
   * `List-Unsubscribe` and its one-click partner. Gmail and Yahoo require both
   * on bulk mail, and a sender without them lands in spam whatever the content
   * says.
   */
  readonly headers: Readonly<Record<string, string>>;
}

export interface EmailOptions {
  /**
   * Base URL where web-lite is served. Optional because web-lite is not
   * deployed anywhere yet — with nothing set, the button falls back to the
   * `baaki://` deep link, which works on the phone and does nothing in desktop
   * webmail. A dead `https://` link would be worse: it looks like it should
   * work.
   */
  readonly webUrl?: string | null;
  /** Signed, address-specific, and safe to POST without a session. */
  readonly unsubscribeUrl: string;
}

/**
 * `baaki://group/<id>/expense/<id>` becomes `<web>/g/<id>`.
 *
 * The trailing segments are dropped rather than translated: web-lite has a
 * group page and no expense page, and landing somebody on the group they were
 * told about beats landing them on a 404 that proves the mail was right.
 *
 * With no web URL configured the deep link is handed back untouched, and with
 * neither, there is no button — an email is still worth sending for what it
 * says.
 */
export function webLinkFor(
  deepLink: string | null | undefined,
  webUrl?: string | null,
): string | null {
  if (!webUrl) return deepLink ?? null;

  const base = webUrl.replace(/\/+$/, '');
  if (!deepLink) return base;
  if (deepLink.startsWith('http://') || deepLink.startsWith('https://')) return deepLink;

  const group = /^baaki:\/\/group\/([0-9a-fA-F-]{36})/.exec(deepLink);
  return group ? `${base}/g/${group[1]}` : base;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildEmail(row: EmailableNotification, options: EmailOptions): BuiltEmail | null {
  const template = templateForKind(row.kind);
  if (!template) return null;

  const locale = row.locale ?? 'en';
  const language = locale.slice(0, 2).toLowerCase();
  const copy = copyFor(locale);
  const { title, body } = renderNotification(row.kind, row.facts ?? {}, locale, {
    title: row.title,
    body: row.body,
  });

  const action =
    template === 'settlement-confirm' ? copy.email.confirmAction : copy.email.openAction;
  const link = webLinkFor(row.deepLink, options.webUrl);
  const why = interpolate(copy.email.why, { group: row.groupName ?? copy.email.signature });
  const direction = RIGHT_TO_LEFT.has(language) ? 'rtl' : 'ltr';

  return {
    notificationId: row.id,
    to: row.to,
    subject: title,
    html: renderHtml({
      direction,
      title,
      body,
      action,
      link,
      why,
      unsubscribe: copy.email.unsubscribe,
      unsubscribeUrl: options.unsubscribeUrl,
      signature: copy.email.signature,
    }),
    text: [
      title,
      '',
      body,
      '',
      link ?? '',
      '',
      why,
      `${copy.email.unsubscribe}: ${options.unsubscribeUrl}`,
    ]
      .join('\n')
      .trim(),
    template,
    headers: {
      'List-Unsubscribe': `<${options.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

interface HtmlParts {
  readonly direction: 'ltr' | 'rtl';
  readonly title: string;
  readonly body: string;
  readonly action: string;
  readonly link: string | null;
  readonly why: string;
  readonly unsubscribe: string;
  readonly unsubscribeUrl: string;
  readonly signature: string;
}

/**
 * Deliberately plain, inline-styled and image-free.
 *
 * No remote images: a tracking pixel is what makes `opened` events possible and
 * also what makes a mail client hide the whole message behind "load images".
 * The webhook still reports opens when the reader's client fetches Resend's own
 * pixel; we do not add one of ours.
 */
function renderHtml(parts: HtmlParts): string {
  const align = parts.direction === 'rtl' ? 'right' : 'left';
  const button = parts.link
    ? `<a href="${escapeHtml(parts.link)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#1c1917;color:#ffffff;text-decoration:none;font-size:15px;">${escapeHtml(parts.action)}</a>`
    : '';
  return `<!doctype html>
<html dir="${parts.direction}">
<body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;text-align:${align};">
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.35;color:#1c1917;">${escapeHtml(parts.title)}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#44403c;">${escapeHtml(parts.body)}</p>
${button}
<p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#78716c;">${escapeHtml(parts.why)}<br />
<a href="${escapeHtml(parts.unsubscribeUrl)}" style="color:#78716c;">${escapeHtml(parts.unsubscribe)}</a></p>
</div>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#a8a29e;text-align:${align};">${escapeHtml(parts.signature)}</p>
</body>
</html>`;
}

// ─────────────────────────────────────────────── one-click unsubscribe ──

/**
 * A signature over the address, so the unsubscribe URL proves who it is for.
 *
 * RFC 8058 has the mail client POST this URL unattended — no cookie, no login,
 * no confirmation page. Without a signature the parameter would be a plain
 * address, and unsubscribing somebody else would be a matter of editing a query
 * string.
 */
export async function signUnsubscribe(address: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(normaliseAddress(address)),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyUnsubscribe(
  address: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  // Constant time: comparing with `===` leaks where the first byte differs, and
  // this endpoint is unauthenticated by design.
  return constantTimeEquals(await signUnsubscribe(address, secret), signature);
}

/** Lower-cased and trimmed — the same address, however it was typed. */
export function normaliseAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function unsubscribeUrlFor(
  functionsUrl: string,
  address: string,
  signature: string,
): string {
  const base = functionsUrl.replace(/\/+$/, '');
  const query = new URLSearchParams({ address: normaliseAddress(address), sig: signature });
  return `${base}/email-unsubscribe?${query.toString()}`;
}

// ────────────────────────────────────────────────── the webhook signature ──

/**
 * Svix's scheme, which is what Resend signs its webhooks with.
 *
 * This lives here rather than in the edge function for one reason: it is the
 * entire security of an endpoint anybody on the internet can reach, and getting
 * it subtly wrong fails in the direction nobody notices. Every delivery report
 * is answered 401, Resend gives up after a while, and the suppression list
 * quietly freezes at whatever it happened to hold — no error, no alert, just
 * mail going to addresses that bounced last month. Here it is checked in CI
 * against Svix's published test vector.
 *
 * HMAC-SHA256 over `id.timestamp.body`, keyed with the secret after `whsec_` is
 * stripped and the rest base64-decoded.
 */
export interface WebhookSignatureCheck {
  readonly secret: string;
  readonly id: string;
  readonly timestamp: string;
  /** The raw body text. `JSON.stringify(JSON.parse(body))` is a different string. */
  readonly body: string;
  /** The `svix-signature` header, verbatim. */
  readonly header: string;
  /** Seconds since the epoch. Injectable so the tolerance can be tested. */
  readonly now?: number;
  readonly toleranceSeconds?: number;
}

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export async function verifyWebhookSignature(check: WebhookSignatureCheck): Promise<boolean> {
  const sent = Number(check.timestamp);
  if (!check.timestamp || !Number.isFinite(sent)) return false;

  // Replay protection. Without it a signature stays valid forever, and a body
  // captured once could be posted back at any time.
  const now = check.now ?? Math.floor(Date.now() / 1000);
  const tolerance = check.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(now - sent) > tolerance) return false;

  const raw = check.secret.startsWith('whsec_')
    ? check.secret.slice('whsec_'.length)
    : check.secret;
  let expected: string;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      base64ToBuffer(raw),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    expected = bytesToBase64(
      new Uint8Array(
        await crypto.subtle.sign(
          'HMAC',
          key,
          new TextEncoder().encode(`${check.id}.${check.timestamp}.${check.body}`),
        ),
      ),
    );
  } catch {
    // A secret that is not base64 is a misconfiguration, and the safe reading of
    // a signature check that cannot run is that nothing verifies.
    return false;
  }

  // The header may carry several space-separated versioned signatures, because
  // a secret mid-rotation means two are valid at once. Any one matching is a
  // pass; reading only the first would break every rotation.
  for (const part of check.header.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    if (constantTimeEquals(value, expected)) return true;
  }
  return false;
}

/**
 * Returns the buffer rather than the view. `new Uint8Array(n)` is typed over
 * `ArrayBufferLike`, which could be a `SharedArrayBuffer`, and `importKey` will
 * not take one — so the allocation is made explicit and the `ArrayBuffer` is
 * what leaves.
 */
function base64ToBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
