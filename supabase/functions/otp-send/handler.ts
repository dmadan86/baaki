/**
 * otp-send — Supabase's Send SMS Hook, delivering the sign-in code over
 * WhatsApp instead of SMS.
 *
 * GoTrue normally posts the code to a configured SMS provider itself. With
 * `[auth.hook.send_sms]` pointed here it posts to us instead, handing over the
 * code it generated, and we decide how it travels. Three things come out of
 * owning that step:
 *
 * 1. **WhatsApp, not SMS.** India is the first market and A2P SMS there is
 *    gated on DLT registration with the operators — unregistered traffic is
 *    dropped by the carrier, not by us. WhatsApp business messaging is not A2P
 *    SMS and carries none of that; it is also far cheaper per message and the
 *    code arrives in the app people already have open.
 * 2. **A cap we can actually enforce.** The app calls GoTrue directly, so any
 *    per-day limit written into the client is advice a modified client ignores.
 *    Here it is the server, keyed on the number, and there is no other door.
 * 3. **One place to add SMS fallback later** without touching the app.
 *
 * This is why the Twilio *Verify* provider is switched off in config.toml.
 * Verify mints and checks its own code; inside a send hook that would mean two
 * different codes in play and neither one valid. Owning delivery means owning
 * plain Programmable Messaging.
 *
 * `verify_jwt = false`, and it must stay that way: the caller is GoTrue, which
 * carries no user session. What it carries instead is a standardwebhooks
 * signature over the exact bytes of the body, and — exactly as in
 * `email-events` — that check runs before anything else is read.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { verifyWebhookSignature } from '../_shared/core.js';
import { LIMITS } from '../_shared/rateLimit.ts';

/**
 * Four codes to a number a day. Read from the shared `LIMITS` table rather than
 * written here, so there stays one list of every ceiling in the system even
 * though this function calls the limiter RPC itself (see the note there).
 */
export const OTP_DAILY_LIMIT = LIMITS['otp-send'].limit;
const OTP_WINDOW_SECONDS = LIMITS['otp-send'].windowSeconds;

/**
 * GoTrue reads a refusal from this envelope, not from an HTTP status alone, and
 * shows `message` to the person waiting on the code. It is deliberately not the
 * repo's usual `{code, message}` error shape — the consumer here is GoTrue, not
 * our own client.
 */
function hookError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { http_code: status, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export interface SendSmsHookPayload {
  user?: { id?: string; phone?: string };
  sms?: { otp?: string };
}

export interface OtpSendDeps {
  /** Service-role client. The rate-limit RPC refuses any other caller. */
  service: () => SupabaseClient;
  fetchImpl: typeof fetch;
  env: (key: string) => string | undefined;
  /**
   * Injected so tests need not forge an HMAC. The real implementation is
   * `verifyWebhookSignature` from @waves/core, which CI already checks against
   * Svix's published test vector — there is no second copy of that logic here.
   */
  verify?: typeof verifyWebhookSignature;
}

/**
 * The most body this endpoint will ever buffer.
 *
 * A Send SMS Hook payload is a few hundred bytes — a phone number, a code and
 * some user metadata. 16 KiB is far above anything GoTrue sends and far below
 * anything worth holding in memory.
 */
const MAX_BODY_BYTES = 16 * 1024;

/** How long Twilio gets to answer before the attempt is abandoned. */
const TWILIO_TIMEOUT_MS = 15_000;

/**
 * Read the body, refusing anything oversized before it is all in memory.
 *
 * `verify_jwt = false` here, so anyone on the internet can POST to this
 * endpoint, and the signature cannot be checked until the bytes are in hand —
 * the signature covers exactly those bytes. That ordering is forced, which
 * makes an unbounded `request.text()` a way for an unauthenticated caller to
 * make the isolate buffer whatever it feels like sending. Counting as the
 * stream arrives caps it at the first chunk over the line.
 *
 * `Content-Length` is checked first as a cheap early out; it is absent under
 * chunked encoding and can lie, so the running total is what actually enforces
 * the limit. Returns null when the body is too large.
 */
async function readBoundedText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;

  const reader = request.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** E.164, the only shape GoTrue ever hands us and the only one Twilio takes. */
function isE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}

/**
 * Supabase issues a hook secret as `v1,whsec_<base64>`, and that whole string is
 * what lands in the environment. `verifyWebhookSignature` strips `whsec_` — the
 * shape Resend uses — but not the `v1,` in front of it, so handing the raw value
 * over base64-decodes the wrong bytes and refuses every genuine request. That
 * fails in the direction nobody notices in review: the function is deployed, the
 * hook is enabled, and every sign-in answers 401.
 *
 * The `v1` here is the secret's own version prefix and is unrelated to the `v1`
 * in the signature header, which the verifier reads separately.
 */
export function hookSecret(raw: string): string {
  return raw.startsWith('v1,') ? raw.slice('v1,'.length) : raw;
}

export async function handleOtpSend(request: Request, deps: OtpSendDeps): Promise<Response> {
  if (request.method !== 'POST') return hookError(405, 'Use POST');

  const secret = deps.env('SEND_SMS_HOOK_SECRET');
  if (!secret) {
    // Refused rather than waved through, on the same reasoning as
    // `email-events`: a hook that accepts unsigned callers because nobody has
    // configured it yet is worse than one that is switched off.
    return hookError(500, 'SEND_SMS_HOOK_SECRET is not set');
  }

  const id = request.headers.get('webhook-id');
  const timestamp = request.headers.get('webhook-timestamp');
  const signature = request.headers.get('webhook-signature');
  if (!id || !timestamp || !signature) return hookError(401, 'Not a signed webhook');

  // The raw text, not a reparse — signing covers the exact bytes.
  const body = await readBoundedText(request, MAX_BODY_BYTES);
  if (body === null) return hookError(413, 'That request body is too large');
  const verify = deps.verify ?? verifyWebhookSignature;
  const ok = await verify({ secret: hookSecret(secret), id, timestamp, body, header: signature });
  if (!ok) return hookError(401, 'That signature does not match');

  let payload: SendSmsHookPayload;
  try {
    payload = JSON.parse(body) as SendSmsHookPayload;
  } catch {
    return hookError(400, 'Body is not JSON');
  }

  const phone = payload.user?.phone?.trim() ?? '';
  const otp = payload.sms?.otp?.trim() ?? '';
  if (!isE164(phone) || !otp) return hookError(400, 'Missing a phone number or a code');

  // Configuration is checked before the quota is spent. A provider outage still
  // burns an attempt below — the gate deliberately runs ahead of the spend — but
  // a deploy that is simply missing its Twilio secrets should not consume all
  // four of somebody's daily codes for a send this function was never capable of
  // making.
  const accountSid = deps.env('TWILIO_ACCOUNT_SID');
  const authToken = deps.env('TWILIO_AUTH_TOKEN');
  const from = deps.env('TWILIO_WHATSAPP_FROM');
  const contentSid = deps.env('TWILIO_OTP_CONTENT_SID');
  if (!accountSid || !authToken || !from || !contentSid) {
    return hookError(500, 'WhatsApp sending is not configured');
  }

  // Counted before the message is sent, matching `receipt-parse`, where the
  // gate always runs ahead of the spend. The cost is that a Twilio outage still
  // burns an attempt; the alternative — send first, count after — lets a script
  // spend the whole day's allowance before the first count lands.
  //
  // Keyed on the number rather than a profile id: `auth.sms.enable_signup` is
  // off, so one number is one account, and the number is the only identity that
  // exists at the moment a code is asked for.
  const { data, error } = await deps.service().rpc('baaki_rate_limit', {
    p_subject: `phone:${phone}`,
    p_bucket: 'otp-send',
    p_limit: OTP_DAILY_LIMIT,
    p_window_seconds: OTP_WINDOW_SECONDS,
  });

  if (error) {
    // Fails open, the same trade the shared limiter makes: the only way this
    // happens is the database being unreachable, and refusing every sign-in
    // during a database blip does more damage than the abuse it guards against.
    console.error('otp-send rate limit check failed, allowing:', error.message);
  } else {
    const decision = data as { allowed?: boolean; retryAfter?: number } | null;
    if (decision && decision.allowed === false) {
      return hookError(
        429,
        `That is ${OTP_DAILY_LIMIT} codes today. Try again tomorrow, or sign in another way.`,
      );
    }
  }

  // A business-initiated WhatsApp message must be a template Meta has approved,
  // referenced by its Content SID; free-form text is only allowed inside a
  // 24-hour window a sign-in has no reason to be in. `ContentVariables` fills
  // the template's one placeholder with the code.
  const form = new URLSearchParams({
    To: `whatsapp:${phone}`,
    From: from.startsWith('whatsapp:') ? from : `whatsapp:${from}`,
    ContentSid: contentSid,
    ContentVariables: JSON.stringify({ '1': otp }),
  });

  // A refused connection, a DNS failure or a timeout rejects rather than
  // answering, and an exception escaping here would leave GoTrue with a bare 500
  // and the caller with whatever a stack trace renders as. A network failure and
  // a 500 from Twilio mean the same thing to the person waiting, so they get the
  // same sanitised answer.
  let response: Response;
  try {
    response = await deps.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        // Well inside the runtime's own idle timeout, so a Twilio call that
        // hangs is abandoned here — where it becomes the sanitised 502 below —
        // rather than holding the isolate until the platform kills it and
        // GoTrue is left with nothing at all.
        signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
      },
    );
  } catch (caught) {
    console.error('twilio whatsapp request failed', caught);
    return hookError(502, 'Could not send the code just now. Try again in a moment.');
  }

  if (!response.ok) {
    // Twilio's own message is logged, never returned: it can name the sender
    // and the account, and this text is shown to whoever asked for the code.
    const detail = await response.text().catch(() => '');
    console.error('twilio whatsapp send failed', response.status, detail);
    return hookError(502, 'Could not send the code just now. Try again in a moment.');
  }

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
