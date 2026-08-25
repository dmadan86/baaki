import 'server-only';

import { cookies, headers } from 'next/headers';

import { SESSION_COOKIE, constantTimeEquals, csrfTokenFor } from './session';

/**
 * The browser-side half of the door.
 *
 * The trusted-origin secret in `proxy.ts` proves a request came through
 * Cloudflare; this proves a *mutating* request came from this console's own
 * pages rather than from another site a signed-in operator happened to visit.
 * The session cookie is `SameSite=Lax`, which already blocks the cross-site POST
 * in a modern browser — but Lax is one layer, and a console that reads and
 * writes the whole business should not rest a mutation on a single one. So every
 * server action that changes something calls `guardMutation` first, and it takes
 * two independent things to pass: the request's `Origin` must be this host, and
 * the form must carry a token only a holder of the session cookie could have
 * computed.
 *
 * One helper, called at the top of each action, so a new action added later
 * fails the same way rather than shipping unguarded.
 */

/**
 * Refusal with a message safe to show. Distinct type so an action could tell it
 * apart from a validation error if it ever wanted to; today they both surface as
 * text on the page.
 */
export class RequestRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestRejected';
  }
}

const CSRF_FIELD = '_csrf';

/**
 * Rejects a request whose `Origin` is missing or is not this host.
 *
 * The expected host is the request's own `Host` header — the value the browser
 * set to reach us, not anything in the request body — unless `ADMIN_ALLOWED_ORIGIN`
 * pins it explicitly, which is the belt for a deployment that terminates TLS
 * somewhere that rewrites `Host`. A cross-site form POST carries the attacker's
 * `Origin`, which will not match; a same-origin submit carries ours, which will.
 */
export async function assertSameOrigin(): Promise<void> {
  const h = await headers();
  const origin = h.get('origin');
  if (!origin) {
    throw new RequestRejected('This request arrived without an Origin and was refused.');
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new RequestRejected('This request carried a malformed Origin and was refused.');
  }

  const configured = process.env.ADMIN_ALLOWED_ORIGIN;
  const expectedHost = configured ? new URL(configured).host : (h.get('host') ?? '');
  if (!expectedHost || originHost !== expectedHost) {
    throw new RequestRejected('This request came from another site and was refused.');
  }
}

/**
 * The token to embed in a form, bound to the current session. Empty when there
 * is no session (the login form, which has no session-bound token and leans on
 * the Origin check alone).
 */
export async function csrfToken(): Promise<string> {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) return '';
  return csrfTokenFor(session);
}

/** Rejects a form whose CSRF token is missing or does not match the session. */
export async function assertCsrfToken(formData: FormData): Promise<void> {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) {
    throw new RequestRejected('Your session has expired. Reload and sign in again.');
  }
  const expected = await csrfTokenFor(session);
  const provided = String(formData.get(CSRF_FIELD) ?? '');
  if (!provided || !(await constantTimeEquals(provided, expected))) {
    throw new RequestRejected('This form was stale or forged. Reload the page and try again.');
  }
}

/**
 * The one call every mutating server action makes, first thing. Origin then
 * token: a cross-site request usually fails the Origin check before a token is
 * even looked at.
 */
export async function guardMutation(formData: FormData): Promise<void> {
  await assertSameOrigin();
  await assertCsrfToken(formData);
}
