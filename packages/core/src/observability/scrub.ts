/**
 * What is allowed to leave the device when something breaks.
 *
 * Crash reporting is a bargain: you learn why the app failed, and in exchange
 * a third party keeps a copy of whatever happened to be in memory at the time.
 * For most apps that is a URL and a stack trace. For Baaki it is a ledger —
 * who ate with whom, how much they still owe, the phone number they were
 * invited on, and the UPI handle they pay from. None of that helps anybody fix
 * a crash, and all of it is somebody else's business.
 *
 * So nothing is trusted to be safe by default. Every event is walked before it
 * is sent: values under a key that holds *content* are replaced outright, and
 * every remaining string is passed through patterns for the things that are
 * identity wherever they turn up.
 *
 * Two things are deliberately kept:
 *
 *  - **Amounts.** "Exact shares sum to 40000 but the expense is 45000" is the
 *    entire diagnosis. A number with no name attached identifies nobody.
 *  - **UUIDs.** A group id is a pointer, not the data it points at — and
 *    without it a report cannot be matched to the row that caused it. Only
 *    somebody who already passed RLS can turn one back into a group.
 *
 * Pure, and shared by all three runtimes (mobile, web-lite, edge) so there is
 * one policy rather than three that drift.
 */

export const REDACTED = '[redacted]';

/**
 * Keys whose value is *content*. There is no version of "the expense
 * description, but safe" — it goes, whole.
 *
 * Matched case-insensitively against both `camelCase` and `snake_case`, since
 * an event carries some fields as the app named them and some as the database
 * did.
 */
const SENSITIVE_KEYS = new Set([
  'description',
  'name',
  'displayname',
  'fullname',
  'note',
  'notes',
  'label',
  'merchant',
  'email',
  'phone',
  'invitephone',
  'msisdn',
  'vpa',
  'upi',
  'upiid',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'authorization',
  'password',
  'rawtext',
  'text',
  'body',
  'items',
  'claims',
  'query',
  'search',
  'cookies',
]);

/**
 * Subtrees that are machinery, not content, and are handed back untouched.
 *
 * A stack frame's `filename` is a bundle path and its `abs_path` is a build
 * hash — both long enough to look like a token to the pattern below, and both
 * the only reason the report is worth having. Redacting them would leave a
 * crash report that says a crash happened somewhere.
 *
 * The same goes for the platform blocks: `os.name` is "Android" and
 * `runtime.name` is "hermes", which is how you find out a crash only happens on
 * one of them. `device` is deliberately *not* here — it carries `name`, and a
 * phone is usually named after its owner.
 *
 * The id fields are passed through because Sentry's own identifiers are 32 hex
 * characters, which is exactly what an opaque token looks like. Redacting them
 * detaches an event from its trace, or from itself. `trace` itself is *not*
 * here: its subtree also carries `op`, `description` and a free-form `data`
 * map, any of which can hold an expense description, so it is walked like any
 * other object and only its identifier fields survive.
 */
const PASS_THROUGH_KEYS = new Set([
  'stacktrace',
  'frames',
  'debugmeta',
  'modules',
  'sdk',
  'os',
  'runtime',
  'browser',
  'app',
  'culture',
  'eventid',
  'traceid',
  'spanid',
  'parentspanid',
]);

const canonicalKey = (key: string): string => key.replace(/[_\-\s]/g, '').toLowerCase();

/**
 * `asha@example.co.in` — an address, which needs a dot in the domain.
 *
 * The `{1,64}` is not cosmetic and must not be relaxed to `+`. Unbounded, the
 * engine starts at every one of n positions, consumes the whole run looking for
 * an `@`, fails, and backtracks a character at a time — O(n²) on any long run
 * of `[\w.+-]` that contains no `@` at all. A JWT is exactly that (base64url is
 * `[\w-]` throughout, segments joined by dots), and so is any base64url blob.
 * Measured on this file's own `redactText`: 20k characters took 635ms, 80k took
 * 10.2s, 320k took over a minute.
 *
 * That cost lands in `beforeSend`, on the JS thread, while the app is already
 * crashing — a frozen phone on top of the fault being reported. 64 is the limit
 * RFC 5321 puts on a local part, so nothing real is lost by refusing to look
 * past it; the bound is what stops the retry from every start position.
 */
// The `(?<![\w.+-])` anchor makes the 64-char bound a real ceiling rather than
// a sliding window: without it, an over-length run like `a`×65`@x.com` would
// still match on its trailing 64 characters and be half-redacted (`a[email]`).
// Refusing to start mid-run means an over-length local part — which RFC 5321
// forbids anyway — is left untouched, not partially scrubbed.
const EMAIL = /(?<![\w.+-])[\w.+-]{1,64}@[\w-]+(?:\.[\w-]+)+/g;

/**
 * `9876543210@ybl`, `ravi.k@okaxis` — a UPI handle, which is the same shape
 * without the dot. Checked after email so an address is never mistaken for one.
 *
 * Bounded for the same reason as EMAIL, and comfortably above any real handle:
 * NPCI caps a VPA at 50 characters end to end, so 64 for the part before the
 * `@` cannot exclude one.
 */
const VPA = /(?<![\w.-])[\w.-]{2,64}@[a-z]{2,}\b/gi;

/**
 * `+91 98765 43210` in any of the spacings a keyboard produces. Always with a
 * country code, because `normalisePhone` refuses a number without one — which
 * is what makes it safe to leave bare digit runs alone, and bare digit runs are
 * how money is written.
 */
const PHONE = /\+\d[\d\s\-().]{6,18}\d/g;

/**
 * A long opaque run: an invite token (64 base36 characters), a JWT segment, a
 * session token. Anything with this much entropy is a credential or an
 * identifier of a person, never a diagnosis.
 */
const OPAQUE = /\b[A-Za-z0-9_-]{24,}\b/g;

/** Kept: a pointer to a row, not the row. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Also kept: a plain hex run, which is what Sentry's own `event_id` and
 * `trace_id` are. Nothing Baaki treats as a secret is hex — an invite token is
 * 64 base36 characters and a session token is a JWT — so this exemption costs
 * nothing and stops a report being detached from its own trace.
 */
const HEX_ID = /^[0-9a-f]+$/i;

/**
 * Postgres quotes the offending value back at you: `Key (name)=(Goa trip)
 * already exists`. That message travels through PostgREST into an edge
 * function's `error.message` and out into a report, carrying a row's contents
 * in a string nobody wrote by hand. The column name is kept — it is the
 * diagnosis — and the value is not.
 */
const PG_KEY_VALUE = /(\bKey \([^)]*\)=\()[^)]*\)/g;

/** Identity, wherever it appears in a sentence. */
export function redactText(input: string): string {
  return input
    .replace(PG_KEY_VALUE, `$1${REDACTED})`)
    .replace(EMAIL, '[email]')
    .replace(VPA, '[vpa]')
    .replace(PHONE, '[phone]')
    .replace(OPAQUE, (match) => (UUID.test(match) || HEX_ID.test(match) ? match : '[token]'));
}

/**
 * A URL, with everything that travels in one removed.
 *
 * The query string goes wholesale: PostgREST puts the filter there, so a failed
 * read of an expense carries `description=eq.Dinner%20with%20Asha` in plain
 * sight. The path is kept — it is what tells you *which* endpoint broke — but
 * an opaque segment in it is an invite token, which grants access to a group
 * and must never be readable in a bug report.
 */
export function redactUrl(input: string): string {
  const [path, query] = splitOnce(input, '?');
  const cleanPath = redactText(path);
  return query === null ? cleanPath : `${cleanPath}?${REDACTED}`;
}

function splitOnce(input: string, separator: string): [string, string | null] {
  const at = input.indexOf(separator);
  return at === -1 ? [input, null] : [input.slice(0, at), input.slice(at + 1)];
}

/** How deep to walk before giving up; a Sentry event is nowhere near this. */
const MAX_DEPTH = 12;

/**
 * Walk anything and return it with the private parts removed.
 *
 * Structure is preserved — keys stay, arrays stay arrays — because a report
 * with the shape intact is still readable. Only the values change. Cycles and
 * exotic objects (Date, Error, class instances) are left alone rather than
 * half-copied into something misleading.
 */
export function scrub<T>(value: T): T {
  return walk(value, 0, new WeakSet()) as T;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  // Track the current path, not every object ever seen: a Sentry event often
  // references one object from two places, and dropping it from the set once its
  // children are walked keeps that a shared reference rather than a false cycle.
  try {
    return walkChildren(value, depth, seen);
  } finally {
    seen.delete(value);
  }
}

function walkChildren(value: object, depth: number, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((entry) => walk(entry, depth + 1, seen));

  // Not a plain object — a Date, a RegExp, an Error, something with a
  // prototype. Copying it field by field would produce a lie, so it is passed
  // through as it is.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const canonical = canonicalKey(key);
    if (PASS_THROUGH_KEYS.has(canonical)) {
      out[key] = entry;
      continue;
    }
    if (SENSITIVE_KEYS.has(canonical)) {
      out[key] = REDACTED;
      continue;
    }
    if (typeof entry === 'string' && looksLikeUrl(entry)) {
      out[key] = redactUrl(entry);
      continue;
    }
    out[key] = walk(entry, depth + 1, seen);
  }
  return out;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
