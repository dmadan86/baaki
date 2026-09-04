/**
 * Who is allowed in.
 *
 * One operator, one password, a signed cookie. Deliberately not Supabase Auth:
 * this console must keep working when the thing it is watching is broken, and
 * an admin login that depends on the app's own auth is one that goes down with
 * it. It is also a different trust boundary — a Waves account is something
 * anonymous guests get for free (ADR-006), and no amount of allowlisting makes
 * "signed in to the app" mean "may read the whole business".
 *
 * Web Crypto rather than `node:crypto`, because this runs in middleware as well
 * as in server components and the two do not have the same globals.
 *
 * What this is not: it is a single shared secret, so it has no second factor
 * and no revocation short of changing the password. That is an accepted trade
 * for a private, single-operator console — and the reason the deployment notes
 * say to put it behind network restriction too rather than only behind this.
 */

const COOKIE = 'waves_admin';

/** Eight hours. Long enough for a working day, short enough to not be a key. */
const TTL_SECONDS = 8 * 60 * 60;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The admin console refuses to start without it — ` +
        'see apps/admin/.env.example.',
    );
  }
  return value;
}

/** Base64url, because a cookie value may not contain `+`, `/` or `=`. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return toBase64Url(new Uint8Array(signature));
}

/**
 * Compares two strings without leaking how far they matched.
 *
 * Both sides are HMACed with a key generated for this process before being
 * compared, so the comparison runs over fixed-length digests an attacker cannot
 * predict — the standard way to get a constant-time compare when the runtime
 * does not offer one. A plain `===` on the password would leak its length and
 * its prefix through timing.
 */
let cachedCompareKey: string | null = null;
function compareKey(): string {
  // Generated on first use, not at module load: module-scope
  // crypto.getRandomValues can fail Next.js prerendering.
  if (cachedCompareKey === null) {
    cachedCompareKey = crypto.getRandomValues(new Uint8Array(32)).join('');
  }
  return cachedCompareKey;
}

async function equals(a: string, b: string): Promise<boolean> {
  const key = compareKey();
  const [left, right] = await Promise.all([hmac(a, key), hmac(b, key)]);
  return left === right;
}

export async function checkPassword(candidate: string): Promise<boolean> {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  return equals(candidate, required('ADMIN_PASSWORD'));
}

/** `<expiry>.<signature>`. There is nothing to say beyond "this was us". */
export async function issueToken(): Promise<{ name: string; value: string; maxAge: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const signature = await hmac(String(expiresAt), required('ADMIN_SESSION_SECRET'));
  return { name: COOKIE, value: `${expiresAt}.${signature}`, maxAge: TTL_SECONDS };
}

export async function isValidToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [expiresAt, signature] = token.split('.');
  if (!expiresAt || !signature) return false;

  // Signature first, then expiry: an unsigned token has no expiry worth reading.
  const expected = await hmac(expiresAt, required('ADMIN_SESSION_SECRET'));
  if (!(await equals(signature, expected))) return false;

  const seconds = Number(expiresAt);
  return Number.isFinite(seconds) && seconds > Math.floor(Date.now() / 1000);
}

export const SESSION_COOKIE = COOKIE;

/**
 * The second door: proof the request arrived through the trusted proxy.
 *
 * The custom domain (`waves.dmadan.com`) is on Vercel Hobby, whose Deployment
 * Protection does not cover custom domains, and the `*.vercel.app` origin stays
 * reachable directly — so a valid session cookie alone does not prove a request
 * came through Cloudflare Access. Cloudflare injects a shared secret header (a
 * Transform Rule) that only it and this app know; a request that lacks it did
 * not pass through the front door and is refused, cookie or no cookie. A host
 * check would not do: the Host header is exactly what an attacker sets when
 * sending a request straight to the `.vercel.app` origin.
 *
 * The compare is constant-time (HMAC-then-`===`, as everywhere else here) so the
 * secret cannot be recovered a byte at a time from response timing.
 */
export const ORIGIN_SECRET_HEADER = 'x-admin-origin-secret';

/**
 * A constant-time string compare, exposed for the CSRF check next door. Same
 * HMAC-then-`===` shape the rest of this file uses, so a token cannot be
 * recovered a byte at a time from how long the comparison took.
 */
export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  return equals(a, b);
}

/**
 * A CSRF token bound to one session.
 *
 * Derived from the session cookie's value under the same secret, so it needs no
 * second cookie to set (server components cannot set one during render anyway)
 * and no server-side store. A cross-site attacker cannot read the victim's
 * httpOnly session cookie, so cannot compute this, so cannot forge a form that
 * carries it. The `csrf.` prefix keeps this HMAC from ever colliding with the
 * session signature, which is the same input under the same key.
 */
export async function csrfTokenFor(sessionValue: string): Promise<string> {
  return hmac(`csrf.${sessionValue}`, required('ADMIN_SESSION_SECRET'));
}

/**
 * Fail-safe when `ADMIN_ORIGIN_SECRET` is unset.
 *
 * In production an unset secret means the second door was never wired up, and
 * the safe answer to that is to refuse everything rather than silently fall back
 * to cookie-only on a publicly reachable hostname — so this returns `false`,
 * i.e. no request is trusted until the secret is configured. In development
 * there is no Cloudflare in front of `localhost`, so an unset secret skips the
 * check (returns `true`) and the console still opens on a dev machine.
 */
export async function hasTrustedOrigin(headerValue: string | null | undefined): Promise<boolean> {
  const secret = process.env.ADMIN_ORIGIN_SECRET;
  if (!secret) {
    // Secure default: closed in production, open only off it.
    return process.env.NODE_ENV !== 'production';
  }
  if (!headerValue) return false;
  return equals(headerValue, secret);
}
