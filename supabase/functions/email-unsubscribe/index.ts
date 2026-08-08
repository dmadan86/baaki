/**
 * email-unsubscribe — the way out, one click, no account (TDR §7.3).
 *
 * Reachable without a JWT, like `email-events`, and for a stronger reason: the
 * person clicking may not have the app, may not be signed in anywhere, and may
 * be reading in a client that does the unsubscribing for them. RFC 8058 has the
 * mail client POST this URL unattended when somebody presses the button Gmail
 * puts next to the sender's name.
 *
 * What stands in for a session is the signature on the address. Without it the
 * query string would be `?address=someone@example.com` and unsubscribing a
 * stranger would be a matter of typing theirs.
 *
 * GET does not unsubscribe. Corporate mail scanners follow every link in every
 * message before it is delivered, and an endpoint that acts on GET would
 * unsubscribe people who never opened the mail. A GET renders a page with a
 * button; the button posts.
 */

import { asService, CORS_HEADERS, errorResponse, HttpError, json } from '../_shared/auth.ts';
import { normaliseAddress, verifyUnsubscribe } from '../_shared/core.js';

const HTML_HEADERS = { ...CORS_HEADERS, 'content-type': 'text/html; charset=utf-8' };

function page(title: string, message: string, form?: { address: string; sig: string }): Response {
  const button = form
    ? `<form method="post"><input type="hidden" name="address" value="${escape(form.address)}" />
<input type="hidden" name="sig" value="${escape(form.sig)}" />
<button type="submit" style="padding:12px 20px;border:0;border-radius:8px;background:#1c1917;color:#fff;font-size:15px;cursor:pointer;">Stop these emails</button></form>`
    : '';
  return new Response(
    `<!doctype html><html><body style="margin:0;padding:48px 24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;">
<h1 style="margin:0 0 12px;font-size:20px;color:#1c1917;">${escape(title)}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#44403c;">${escape(message)}</p>
${button}</div></body></html>`,
    { headers: HTML_HEADERS },
  );
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    const url = new URL(request.url);
    let address = url.searchParams.get('address') ?? '';
    let signature = url.searchParams.get('sig') ?? '';

    // One-click clients post the parameters in the body rather than the query,
    // and our own confirmation page does the same.
    if (request.method === 'POST') {
      const contentType = request.headers.get('content-type') ?? '';
      if (contentType.includes('form')) {
        const form = await request.formData();
        address = (form.get('address') as string | null) ?? address;
        signature = (form.get('sig') as string | null) ?? signature;
      }
    }

    address = normaliseAddress(address);
    const secret = Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET');
    if (!secret) throw new HttpError(500, 'MISCONFIGURED', 'EMAIL_UNSUBSCRIBE_SECRET is not set');

    if (!address || !signature || !(await verifyUnsubscribe(address, signature, secret))) {
      // The same answer for a bad signature and an address that was never
      // mailed. Otherwise this endpoint tells anybody who asks whether a given
      // person is on Baaki.
      if (request.method === 'GET') {
        return page('That link has expired', 'Open Baaki and turn email off in Settings.');
      }
      throw new HttpError(400, 'BAD_LINK', 'That unsubscribe link is not valid');
    }

    if (request.method === 'GET') {
      return page(
        'Stop these emails?',
        `We will stop mailing ${address}. Your notifications stay in the app.`,
        { address, sig: signature },
      );
    }

    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST');

    const { error } = await asService().rpc('baaki_suppress_email', {
      p_address: address,
      p_reason: 'unsubscribed',
      p_detail: { source: 'one-click' },
    });
    if (error) throw new HttpError(500, 'INTERNAL', error.message);

    // One-click clients ignore the body; a person reading it does not.
    return request.headers.get('accept')?.includes('text/html')
      ? page('Done', `We will not email ${address} again. Everything is still in the app.`)
      : json({ ok: true });
  } catch (error) {
    return errorResponse(error, { fn: 'email-unsubscribe' });
  }
});
