/**
 * How often anybody may call these functions.
 *
 * Every limit in one file, because the alternative is a number per function and
 * no way to answer "what are we actually allowing" without reading seven of
 * them. Changing a limit should be a one-line diff somebody can review on its
 * own.
 *
 * The counting happens in Postgres (`waves_rate_limit`), not here. An in-memory
 * counter would be per-isolate, and Supabase runs as many isolates as it likes
 * and tears them down between requests — which makes an in-memory limiter a
 * limiter of roughly nothing, and worse, one that looks like it works in a
 * single-instance test.
 *
 * This is abuse control and not billing. `waves_receipt_scan_quota` is the one
 * that decides what somebody has paid for; it stays where it is and keeps its
 * own message, because "you have used this month's scans" and "you are going
 * too fast" send a person to do two completely different things.
 */

import { HttpError, type SupabaseClient } from './auth.ts';

/**
 * A window and an allowance per bucket.
 *
 * The numbers are set so that a person using the app normally never meets one.
 * `sync` is the loose one because the sync engine is entitled to be chatty —
 * it pushes on every mutation and pulls on every foreground. `exportData` is
 * the tight one because each call reads a whole group and builds a file.
 */
export const LIMITS = {
  /** The sync engine, which talks on every mutation and every foreground. */
  sync: { limit: 120, windowSeconds: 60 },
  /** Writing an expense. Far above any human, well below a script. */
  'expense-write': { limit: 60, windowSeconds: 60 },
  /** Reads an entire group and builds a file. Nobody needs this per minute. */
  'export-data': { limit: 10, windowSeconds: 3600 },
  /** Calls an upstream rate provider that has its own opinion about this. */
  'fx-rate': { limit: 60, windowSeconds: 60 },
  /** Minting is already capped at 5 live links per group; this caps the churn. */
  'invite-mint': { limit: 30, windowSeconds: 3600 },
  /**
   * The token oracle, and the reason this file exists. Keyed on address rather
   * than profile, because the preview answers before anybody has signed in.
   * Thirty an hour is more opening of links than any real person does and
   * roughly 10^-70 of the space needed to find a live token.
   */
  'invite-accept': { limit: 30, windowSeconds: 3600 },
  /**
   * On top of the monthly scan quota, not instead of it. The quota stops the
   * bill; this stops twenty scans being spent in four seconds by a stuck retry
   * loop before anybody notices.
   */
  'receipt-parse': { limit: 10, windowSeconds: 60 },
  /**
   * Erasing an account: rare, idempotent, and a caller only ever does it to
   * their own. The cap is a fuse on the admin API behind it, so a stuck
   * recovery retry backs off rather than hammering `deleteUser` all hour.
   */
  'account-delete': { limit: 5, windowSeconds: 3600 },
  /**
   * Sign-in codes over WhatsApp, four to a number a day. Unlike every other
   * bucket here this one is a product rule rather than an abuse ceiling — four
   * is roughly "you mistyped, you waited, you tried the other phone", and a
   * fifth is somebody else's problem. `otp-send` calls `waves_rate_limit`
   * directly rather than through `enforceRateLimit`, because the subject is a
   * phone number (nobody has signed in yet) and the refusal has to come back in
   * GoTrue's error envelope, not ours — the limit lives here so there is still
   * one list of every ceiling in the system.
   */
  'otp-send': { limit: 4, windowSeconds: 86400 },
} as const;

export type Bucket = keyof typeof LIMITS;

/**
 * Who to count this call against.
 *
 * A profile when there is one. Otherwise the client address, prefixed so it can
 * never be mistaken for — or collide with — a profile id.
 *
 * `x-forwarded-for` is a list, and the first entry is the client as seen by the
 * first proxy. It is spoofable in general; behind Supabase's gateway the last
 * hop is rewritten, and in any case the fallback matters only for the one
 * unauthenticated path. Somebody willing to forge headers per request gets a
 * slower oracle rather than an open one, which is the point.
 */
export function subjectFor(request: Request, profileId?: string | null): string {
  if (profileId) return profileId;
  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const first = forwarded.split(',')[0]?.trim();
  return `ip:${first || 'unknown'}`;
}

interface Decision {
  allowed: boolean;
  retryAfter: number;
  limit: number;
  remaining: number;
}

/**
 * Counts this call and throws a 429 if it is one too many.
 *
 * `service` and not the caller's client: `waves_rate_limit` is granted to
 * `service_role` alone. It takes the subject as an argument, so a client able
 * to call it could spend somebody else's allowance for them.
 *
 * Fails open. If the count cannot be taken the request proceeds, because the
 * only way that happens is the database being unreachable — and every one of
 * these functions is about to talk to that same database anyway. A limiter that
 * turns a database blip into a total outage has done more damage than the abuse
 * it was watching for.
 */
export async function enforceRateLimit(
  service: SupabaseClient,
  request: Request,
  bucket: Bucket,
  profileId?: string | null,
): Promise<void> {
  const { limit, windowSeconds } = LIMITS[bucket];
  const subject = subjectFor(request, profileId);

  const { data, error } = await service.rpc('waves_rate_limit', {
    p_subject: subject,
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    console.error(`rate limit check failed for ${bucket}, allowing:`, error.message);
    return;
  }

  const decision = data as Decision | null;
  if (!decision || decision.allowed) return;

  const retryAfter = Math.max(Number(decision.retryAfter) || 1, 1);
  throw new HttpError(429, 'RATE_LIMITED', tooFast(retryAfter), {
    'Retry-After': String(retryAfter),
  });
}

/**
 * English, and left that way on purpose.
 *
 * The app ships in four languages (TDR §11) and an edge function has no idea
 * which one the caller reads — the language lives in the app, not in the JWT.
 * The client matches on the `RATE_LIMITED` code and says this in the right
 * language; this text is the fallback for anything that does not, which in
 * practice means a log line or a curl.
 */
function tooFast(retryAfter: number): string {
  const wait =
    retryAfter < 60
      ? `${retryAfter} seconds`
      : `${Math.ceil(retryAfter / 60)} minute${retryAfter >= 120 ? 's' : ''}`;
  return `Too many requests. Try again in about ${wait}.`;
}
