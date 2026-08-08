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

import { asService, CORS_HEADERS, errorResponse, HttpError, json } from '../_shared/auth.ts';

/** Svix rejects anything older than this, and so do we. Replay protection. */
const TOLERANCE_SECONDS = 5 * 60;

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

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Svix's scheme: HMAC-SHA256 over `id.timestamp.body`, keyed with the secret
 * after `whsec_` is stripped and the rest base64-decoded.
 *
 * The header may carry several space-separated versioned signatures, because a
 * secret being rotated means two are valid at once. Any one matching is a pass;
 * comparing only the first would break every rotation.
 */
async function signatureIsValid(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  header: string,
  body: string,
): Promise<boolean> {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(raw),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = bytesToBase64(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${svixId}.${svixTimestamp}.${body}`),
      ),
    ),
  );

  for (const part of header.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    if (constantTimeEquals(value, expected)) return true;
  }
  return false;
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

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

    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(svixTimestamp));
    if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
      throw new HttpError(401, 'STALE', 'That signature is too old to trust');
    }

    // The raw text, not a reparse. Signing covers the exact bytes, and
    // `JSON.stringify(JSON.parse(body))` is not the same string.
    const body = await request.text();
    if (!(await signatureIsValid(secret, svixId, svixTimestamp, svixSignature, body))) {
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
