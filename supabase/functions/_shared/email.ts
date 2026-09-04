/**
 * Handing a built email to whichever provider carries it (TDR §7.3).
 *
 * Everything worth testing is in `@waves/core` — what may be mailed, what it
 * says, what the unsubscribe link is. This file is the part that cannot be
 * tested without a network: an API key, a `From`, and the handful of decisions
 * that only matter when the send goes wrong.
 *
 * The one that matters most is the difference between "this will never work"
 * and "this did not work just now". A provider refusing an address permanently
 * and a provider being rate-limited look almost identical at the call site, and
 * getting them the wrong way round means either a settlement confirmation is
 * silently dropped or a dead address is retried every five minutes forever.
 * That rule is decided once, in `sendVia`, and applied to every provider.
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
const SENDGRID_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

/**
 * Which service actually carries the mail.
 *
 * The choice is an environment variable rather than a row in `service_config`,
 * unlike the voice provider knob. A provider cannot be switched without also
 * deploying that provider's API key, and those live in edge-function env — so a
 * database knob able to select a provider whose key is absent would let one
 * click stop every email in the system, with the failure showing up only in a
 * log. Tying the two together means the switch and the credential move at once.
 */
export type EmailProviderId = 'resend' | 'sendgrid';

export function emailProvider(): EmailProviderId {
  const raw = (Deno.env.get('EMAIL_PROVIDER') ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'resend') return 'resend';
  if (raw === 'sendgrid') return 'sendgrid';
  // Refused rather than quietly defaulting: a typo that silently keeps sending
  // through the old provider is how a migration gets declared done twice.
  throw new HttpError(
    500,
    'MISCONFIGURED',
    `EMAIL_PROVIDER "${raw}" is not a provider this build knows`,
  );
}

/** The API key the selected provider needs, by name. */
export function emailKeyName(provider: EmailProviderId = emailProvider()): string {
  return provider === 'sendgrid' ? 'SENDGRID_API_KEY' : 'RESEND_API_KEY';
}

/**
 * Whether this deployment can send mail, and if not, why.
 *
 * Callers check it before claiming rows, so a deployment that cannot send
 * leaves the queue untouched rather than claiming a batch and failing every
 * send in it — a claimed row is one nothing will look at again.
 *
 * The reason is carried rather than collapsed to a boolean because the three
 * cases want three different reactions. "No key set" is a deployment that has
 * not turned email on: normal, silent, not a fault. The other two are faults,
 * and a fault that reads as "email is off" is one nobody finds until somebody
 * asks why the mail stopped.
 */
export type EmailSendable = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function emailSendable(): EmailSendable {
  let provider: EmailProviderId;
  try {
    provider = emailProvider();
  } catch (misconfigured) {
    return { ok: false, reason: (misconfigured as Error).message };
  }

  // SendGrid cannot safely carry a queue that retries. Both senders turn a
  // network failure into `retry`, which is only sound because Resend takes an
  // idempotency key and collapses the resend. SendGrid has no equivalent, so a
  // send whose outcome we never learned would be sent again — and the id in
  // `custom_args` lets a duplicate be recognised afterwards, not prevented.
  // Until there is durable suppression or event-based reconciliation, this is
  // refused loudly rather than left as a note somebody has to read first.
  if (provider === 'sendgrid') {
    return {
      ok: false,
      reason:
        'EMAIL_PROVIDER=sendgrid cannot serve the retrying mail queues yet: SendGrid has no idempotency key, so a send whose outcome was never learned would be delivered twice.',
    };
  }

  if (!Deno.env.get(emailKeyName(provider)) || !Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET')) {
    return { ok: false, reason: '' };
  }

  return { ok: true };
}

/** One message, in the shape both providers are built from. */
interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly headers: Record<string, string>;
  /**
   * The notification or send-row id. Resend takes it as an idempotency key;
   * SendGrid has no such header, so it travels as a custom argument instead and
   * comes back on every delivery event (see `sendVia`).
   */
  readonly key: string;
}

/**
 * What a provider said, normalised.
 *
 * `ok` is carried explicitly rather than inferred from `messageId` being
 * present: SendGrid's success is the 202 itself, and the id arrives in a header
 * it is not obliged to send. Reading "no id" as "failed" would mark a delivered
 * mail as failed and, worse, hand it back to the queue as a retry.
 */
interface ProviderOutcome {
  readonly ok: boolean;
  readonly messageId?: string;
  readonly transient: boolean;
  readonly error?: string;
}

/**
 * `EMAIL_FROM` is one RFC 5322 string ("Waves <hello@…>"). Resend takes it
 * as-is; SendGrid wants the name and the address apart.
 */
function splitFrom(value: string): { email: string; name?: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (!match) return { email: value.trim() };
  const name = match[1].replace(/^"|"$/g, '').trim();
  return name ? { email: match[2].trim(), name } : { email: match[2].trim() };
}

/**
 * Post one message and normalise the answer.
 *
 * The two providers disagree about almost everything at the wire: Resend
 * answers 200 with `{id}`, SendGrid answers **202 with an empty body** and puts
 * its id in a header. What they agree on is which failures come back later —
 * 429 and 5xx — and that rule is applied identically to both, because getting
 * it wrong either drops a settlement confirmation or retries a dead address
 * every five minutes forever.
 */
async function sendVia(
  provider: EmailProviderId,
  message: OutgoingEmail,
): Promise<ProviderOutcome> {
  const from = emailFrom();

  const request: { url: string; init: RequestInit } =
    provider === 'sendgrid'
      ? {
          url: SENDGRID_ENDPOINT,
          init: {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${requiredEnv('SENDGRID_API_KEY')}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              personalizations: [
                {
                  to: [{ email: message.to }],
                  // SendGrid offers no idempotency key. This is the next best
                  // thing: the id rides along and is echoed on every delivery
                  // event, so a duplicate can at least be *recognised* after the
                  // fact even though it cannot be prevented at the call.
                  custom_args: { waves_key: message.key },
                },
              ],
              from: splitFrom(from),
              subject: message.subject,
              // Plain text first: SendGrid treats the array as ascending
              // preference and renders the last part a client can display.
              content: [
                { type: 'text/plain', value: message.text },
                { type: 'text/html', value: message.html },
              ],
              headers: message.headers,
            }),
          },
        }
      : {
          url: RESEND_ENDPOINT,
          init: {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${requiredEnv('RESEND_API_KEY')}`,
              'content-type': 'application/json',
              // TDR §7.3: the notification id is the idempotency key, so a run
              // that times out after sending does not send again when retried.
              'Idempotency-Key': message.key,
            },
            body: JSON.stringify({
              from,
              to: [message.to],
              subject: message.subject,
              html: message.html,
              text: message.text,
              headers: message.headers,
            }),
          },
        };

  const response = await fetch(request.url, request.init);

  if (provider === 'sendgrid') {
    if (response.status === 202) {
      // The body is empty by design; the id is a header.
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: true,
        messageId: response.headers.get('x-message-id') ?? undefined,
        transient: false,
      };
    }
    const detail = (await response.json().catch(() => ({}))) as {
      errors?: { message?: string; field?: string }[];
    };
    const first = detail.errors?.[0];
    return {
      ok: false,
      transient: response.status === 429 || response.status >= 500,
      error: `${response.status} ${first?.field ?? ''} ${first?.message ?? ''}`.trim(),
    };
  }

  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    name?: string;
  };
  if (response.ok && payload.id) return { ok: true, messageId: payload.id, transient: false };
  return {
    ok: false,
    transient: response.status === 429 || response.status >= 500,
    error: `${response.status} ${payload.name ?? ''} ${payload.message ?? ''}`.trim(),
  };
}

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
 * `Waves <hello@mail.dmadan.com>` unless told otherwise.
 *
 * The domain has to be one verified in Resend with SPF, DKIM and DMARC. An
 * unverified sender is not a soft failure — every message is refused outright.
 */
export function emailFrom(): string {
  return Deno.env.get('EMAIL_FROM') ?? 'Waves <hello@mail.dmadan.com>';
}

/**
 * The button an email links to. Two different settings turn it off, on
 * purpose: leaving `EMAIL_WEB_URL` **unset** defaults to the canonical
 * deployment's own domain (`https://wavs.co.in`) — right for the cloud
 * project, wrong for a fork or self-host that has not set its own yet.
 * Setting it to an **explicit empty string** (`EMAIL_WEB_URL=`) opts out of
 * that default deliberately and falls back to the `waves://` deep
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
  let outcome: ProviderOutcome;

  try {
    outcome = await sendVia(emailProvider(), {
      to: built.to,
      subject: built.subject,
      html: built.html,
      text: built.text,
      headers: built.headers,
      key: built.notificationId,
    });
  } catch (unreachable) {
    return {
      id: built.notificationId,
      status: 'retry',
      template: built.template,
      error: (unreachable as Error).message,
    };
  }

  if (outcome.ok) {
    return {
      id: built.notificationId,
      status: 'sent',
      resend_email_id: outcome.messageId,
      template: built.template,
    };
  }

  // 429 is the rate limit and 5xx is the provider having a bad minute. Both come
  // back later; marking them failed would close the row and lose the
  // notification, because the claim only ever looks at rows nothing has touched.
  return {
    id: built.notificationId,
    status: outcome.transient ? 'retry' : 'failed',
    template: built.template,
    error: outcome.error,
  };
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ───────────────────────────────────────────────── the campaign half ──
// The broadcast half of A21. Same Resend call, keyed on the send row rather than
// a notification, and the same one-click unsubscribe — a campaign is bulk mail
// and cannot ship without it. Everything about who gets one is decided in SQL.

/** A row from `waves_claim_campaign_emails` — one person to mail, and the words. */
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
  /** The `campaign_email_sends` row id, so `waves_finish_campaign_emails` matches. */
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
  let outcome: ProviderOutcome;

  try {
    outcome = await sendVia(emailProvider(), {
      to: built.to,
      subject: built.subject,
      html: built.html,
      text: built.text,
      headers: built.headers,
      // The send row id, so a run that times out after the provider accepted
      // does not mail the same person a second copy.
      key: built.sendId,
    });
  } catch (unreachable) {
    return { id: built.sendId, status: 'retry', error: (unreachable as Error).message };
  }

  if (outcome.ok) {
    return { id: built.sendId, status: 'sent', resend_email_id: outcome.messageId };
  }

  // 429 and 5xx come back later; marking them failed would close the row and
  // the person would never be re-picked. A permanent refusal is a real failure.
  return {
    id: built.sendId,
    status: outcome.transient ? 'retry' : 'failed',
    error: outcome.error,
  };
}
