/**
 * Handing a built email to Resend (TDR §7.3).
 *
 * Everything worth testing is in `@waves/core` — what may be mailed, what it
 * says, what the unsubscribe link is. This file is the part that cannot be
 * tested without a network: an API key, a `From`, and the handful of decisions
 * that only matter when the send goes wrong.
 *
 * The one that matters most is the difference between "this will never work"
 * and "this did not work just now". Resend refusing an address permanently and
 * Resend being rate-limited look almost identical at the call site, and getting
 * them the wrong way round means either a settlement confirmation is silently
 * dropped or a dead address is retried every five minutes forever.
 */

import {
  buildEmail,
  renderCampaignEmail,
  signUnsubscribe,
  unsubscribeUrlFor,
  type BuiltCampaignEmail,
  type BuiltEmail,
} from './core.js';
import { HttpError } from './auth.ts';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend's published limit is two requests a second. Sending a claimed batch
 * flat out is the reliable way to have the tail of it refused, so sends are
 * spaced — the fanout runs every five minutes and has nowhere to be.
 */
export const SEND_SPACING_MS = 600;

export interface EmailResult {
  readonly id: string;
  readonly status: 'sent' | 'failed' | 'retry';
  readonly resend_email_id?: string;
  readonly template: string;
  readonly error?: string;
}

export interface EmailableRow {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly deep_link: string | null;
  readonly payload: Record<string, unknown>;
  readonly locale: string;
  readonly address: string;
  readonly group_name: string | null;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(500, 'MISCONFIGURED', `${name} is not set`);
  return value;
}

/**
 * `Baaki <hello@mail.dmadan.com>` unless told otherwise.
 *
 * The domain has to be one verified in Resend with SPF, DKIM and DMARC. An
 * unverified sender is not a soft failure — every message is refused outright.
 */
export function emailFrom(): string {
  return Deno.env.get('EMAIL_FROM') ?? 'Baaki <hello@mail.dmadan.com>';
}

/**
 * The button an email links to. Two different settings turn it off, on
 * purpose: leaving `EMAIL_WEB_URL` **unset** defaults to the canonical
 * deployment's own domain (`https://wavs.co.in`) — right for the cloud
 * project, wrong for a fork or self-host that has not set its own yet.
 * Setting it to an **explicit empty string** (`EMAIL_WEB_URL=`) opts out of
 * that default deliberately and falls back to the `baaki://`/`waves://` deep
 * link instead (dead in desktop webmail, exactly right on a phone) — the
 * right choice for a self-host not yet pointing anywhere it can vouch for.
 */
function emailWebUrl(): string | null {
  return Deno.env.get('EMAIL_WEB_URL') ?? 'https://wavs.co.in';
}

/** Where an unsubscribe click lands. Same origin as every other function. */
function functionsUrl(): string {
  return `${requiredEnv('SUPABASE_URL').replace(/\/+$/, '')}/functions/v1`;
}

export async function buildFor(row: EmailableRow): Promise<BuiltEmail | null> {
  const signature = await signUnsubscribe(row.address, requiredEnv('EMAIL_UNSUBSCRIBE_SECRET'));
  return buildEmail(
    {
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      deepLink: row.deep_link,
      facts: factsOf(row.payload ?? {}),
      locale: row.locale,
      to: row.address,
      groupName: row.group_name,
    },
    {
      webUrl: emailWebUrl(),
      unsubscribeUrl: unsubscribeUrlFor(functionsUrl(), row.address, signature),
    },
  );
}

/** The facts a mail can interpolate, taken from the row that was written. */
function factsOf(payload: Record<string, unknown>): Record<string, string | undefined> {
  const text = (key: string): string | undefined =>
    typeof payload[key] === 'string' ? (payload[key] as string) : undefined;
  return {
    amount: text('amount'),
    currency: text('currency'),
    counterparty: text('counterparty'),
    group: text('group'),
    description: text('description'),
    count: text('count'),
  };
}

export async function sendEmail(built: BuiltEmail): Promise<EmailResult> {
  let response: Response;

  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${requiredEnv('RESEND_API_KEY')}`,
        'content-type': 'application/json',
        // TDR §7.3: the notification id is the idempotency key, so a run that
        // times out after sending does not send again when it is retried.
        'Idempotency-Key': built.notificationId,
      },
      body: JSON.stringify({
        from: emailFrom(),
        to: [built.to],
        subject: built.subject,
        html: built.html,
        text: built.text,
        headers: built.headers,
      }),
    });
  } catch (unreachable) {
    return {
      id: built.notificationId,
      status: 'retry',
      template: built.template,
      error: (unreachable as Error).message,
    };
  }

  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    name?: string;
  };

  if (response.ok && payload.id) {
    return {
      id: built.notificationId,
      status: 'sent',
      resend_email_id: payload.id,
      template: built.template,
    };
  }

  // 429 is the rate limit and 5xx is Resend having a bad minute. Both come back
  // later; marking them failed would close the row and lose the notification,
  // because the claim only ever looks at rows nothing has touched.
  const transient = response.status === 429 || response.status >= 500;
  return {
    id: built.notificationId,
    status: transient ? 'retry' : 'failed',
    template: built.template,
    error: `${response.status} ${payload.name ?? ''} ${payload.message ?? ''}`.trim(),
  };
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ───────────────────────────────────────────────── the campaign half ──
// The broadcast half of A21. Same Resend call, keyed on the send row rather than
// a notification, and the same one-click unsubscribe — a campaign is bulk mail
// and cannot ship without it. Everything about who gets one is decided in SQL.

/** A row from `baaki_claim_campaign_emails` — one person to mail, and the words. */
export interface CampaignEmailRow {
  readonly send_id: string;
  readonly address: string;
  readonly locale: string;
  readonly title: string;
  readonly body: string;
  readonly cta_label: string;
  readonly promo_code: string | null;
}

export interface CampaignSendResult {
  /** The `campaign_email_sends` row id, so `baaki_finish_campaign_emails` matches. */
  readonly id: string;
  readonly status: 'sent' | 'failed' | 'retry';
  readonly resend_email_id?: string;
  readonly error?: string;
}

export async function buildCampaignFor(row: CampaignEmailRow): Promise<BuiltCampaignEmail> {
  const signature = await signUnsubscribe(row.address, requiredEnv('EMAIL_UNSUBSCRIBE_SECRET'));
  return renderCampaignEmail(
    {
      sendId: row.send_id,
      title: row.title,
      body: row.body,
      ctaLabel: row.cta_label,
      promoCode: row.promo_code,
      locale: row.locale,
      to: row.address,
    },
    {
      webUrl: emailWebUrl(),
      unsubscribeUrl: unsubscribeUrlFor(functionsUrl(), row.address, signature),
    },
  );
}

export async function sendCampaignEmail(built: BuiltCampaignEmail): Promise<CampaignSendResult> {
  let response: Response;

  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${requiredEnv('RESEND_API_KEY')}`,
        'content-type': 'application/json',
        // The send row id is the idempotency key, so a run that times out after
        // Resend accepted does not mail the same person a second copy.
        'Idempotency-Key': built.sendId,
      },
      body: JSON.stringify({
        from: emailFrom(),
        to: [built.to],
        subject: built.subject,
        html: built.html,
        text: built.text,
        headers: built.headers,
      }),
    });
  } catch (unreachable) {
    return { id: built.sendId, status: 'retry', error: (unreachable as Error).message };
  }

  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    name?: string;
  };

  if (response.ok && payload.id) {
    return { id: built.sendId, status: 'sent', resend_email_id: payload.id };
  }

  // 429 and 5xx come back later; marking them failed would close the row and
  // the person would never be re-picked. A permanent refusal is a real failure.
  const transient = response.status === 429 || response.status >= 500;
  return {
    id: built.sendId,
    status: transient ? 'retry' : 'failed',
    error: `${response.status} ${payload.name ?? ''} ${payload.message ?? ''}`.trim(),
  };
}
