/**
 * Who is allowed in.
 *
 * One operator, one password, a signed cookie. Deliberately not Supabase Auth:
 * this console must keep working when the thing it is watching is broken, and
 * an admin login that depends on the app's own auth is one that goes down with
 * it. It is also a different trust boundary — a Baaki account is something
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

const COOKIE = 'baaki_admin';

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
const compareKey = crypto.getRandomValues(new Uint8Array(32)).join('');

async function equals(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([hmac(a, compareKey), hmac(b, compareKey)]);
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
