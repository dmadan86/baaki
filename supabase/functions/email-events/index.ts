/**
 * email-events — what Resend says happened to the mail we sent (TDR §7.3).
 *
 * This is the only endpoint in the app that a stranger is meant to be able to
 * reach. It has no JWT, because the caller is Resend and Resend has no Supabase
 * account; what it has instead is a Svix signature over the exact bytes of the
 * body, and the whole security of the endpoint is that check.
 *
 * Which is why the check is done before anything else is read. A webhook that
 * parses first and verifies second is a webhook where a forged `bounced` event
 * suppresses somebody's email — and suppression is deliberately hard to
 * reverse, because it exists to protect a sending reputation that is very easy
 * to lose and very slow to rebuild.
 *
 * `verify_jwt = false` in `supabase/config.toml`, and it must stay there. On
 * the default of true, every delivery report is answered with a 401 and Resend
 * eventually stops sending them — silently, and with the suppression list
 * quietly frozen at whatever it happened to hold.
 */

import { asService, errorResponse, serveWithCors, HttpError, json } from '../_shared/auth.ts';
import { verifyWebhookSignature } from '../_shared/core.js';

interface ResendWebhook {
  type?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { type?: string };
  };
}

/** `email.bounced` → `bounced`. Anything unrecognised is stored under its own name. */
function eventNameOf(type: string): string {
  return type.startsWith('email.') ? type.slice('email.'.length) : type;
}

serveWithCors(async (request) => {
  try {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST');

    const secret = Deno.env.get('RESEND_WEBHOOK_SECRET');
    if (!secret) {
      // Refused rather than waved through. An endpoint that accepts unsigned
      // webhooks because it has not been configured yet is worse than one that
      // is switched off, and Resend will retry once the secret is set.
      throw new HttpError(500, 'MISCONFIGURED', 'RESEND_WEBHOOK_SECRET is not set');
    }

    const svixId = request.headers.get('svix-id');
    const svixTimestamp = request.headers.get('svix-timestamp');
    const svixSignature = request.headers.get('svix-signature');
    if (!svixId || !svixTimestamp || !svixSignature) {
      throw new HttpError(401, 'UNSIGNED', 'Not a signed webhook');
    }

    // The raw text, not a reparse. Signing covers the exact bytes, and
    // `JSON.stringify(JSON.parse(body))` is not the same string.
    //
    // The check itself is in `@waves/core`, where CI runs it against Svix's
    // published test vector. It also enforces the timestamp tolerance, so a
    // body captured once cannot be posted back tomorrow.
    const body = await request.text();
    const verified = await verifyWebhookSignature({
      secret,
      id: svixId,
      timestamp: svixTimestamp,
      body,
      header: svixSignature,
    });
    if (!verified) {
      throw new HttpError(401, 'BAD_SIGNATURE', 'That signature does not match');
    }

    const payload = JSON.parse(body) as ResendWebhook;
    const type = payload.type ?? '';
    const emailId = payload.data?.email_id;
    if (!type || !emailId) {
      // A 200: the webhook was genuine, we simply have nothing to do with it.
      // A 4xx here would have Resend retry a message that will never be useful.
      return json({ ignored: true });
    }

    const to = payload.data?.to;
    const address = Array.isArray(to) ? to[0] : to;

    const { data, error } = await asService().rpc('baaki_record_email_event', {
      p_resend_email_id: emailId,
      p_event: eventNameOf(type),
      p_address: address ?? null,
      p_payload: payload,
    });
    if (error) throw new HttpError(500, 'RECORD_FAILED', error.message);

    return json({ ok: true, ...(data as Record<string, unknown>) });
  } catch (error) {
    return errorResponse(error, { fn: 'email-events' });
  }
});
