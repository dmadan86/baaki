/**
 * invite-mint — turns "let them in" into a link (ADR-006).
 *
 * The raw token exists only in the response and the link. What the database
 * stores is a SHA-256 hash of it, so a leaked `invites` row cannot be replayed
 * into group access, and the table has no SELECT policy at all (TDR §2).
 *
 * The request handling is a pure function over injected boundaries (the two
 * Supabase clients, the membership check, the rate limiter) so it can be
 * unit-tested without Deno or a network. `index.ts` is the thin `Deno.serve`
 * shell that wires the real implementations in.
 */

import { errorResponse, HttpError, json, type SupabaseClient } from '../_shared/auth.ts';

interface MintRequest {
  groupId: string;
  /** How long the link stays usable. Capped so stale links die on their own. */
  expiresInDays?: number;
  maxUses?: number;
}

const MAX_EXPIRY_DAYS = 30;
const MAX_USES_LIMIT = 100;
/** Rate limit: a group cannot mint an unbounded number of live links. */
const MAX_LIVE_INVITES = 5;

/** The side-effecting boundaries `index.ts` injects and tests mock. */
export interface InviteMintDeps {
  asCaller(request: Request): SupabaseClient;
  asService(): SupabaseClient;
  requireMembership(
    caller: SupabaseClient,
    groupId: string,
  ): Promise<{ profileId: string; memberId: string }>;
  enforceRateLimit(
    service: SupabaseClient,
    request: Request,
    bucket: 'invite-mint',
    profileId?: string | null,
  ): Promise<void>;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A `groupId` is required and must be a non-empty string — not whatever the JSON happened to hold. */
function readGroupId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'BAD_GROUP', 'A groupId is required');
  }
  return value;
}

/**
 * A finite numeric option or the default. A client can send `null`, a string or
 * `NaN`; left unchecked, `NaN` flows through the clamp into `new Date(...)` and
 * `toISOString()` throws a RangeError that escapes as a 500. Coerce here so a bad
 * option is simply ignored in favour of the default.
 */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export async function handleInviteMint(request: Request, deps: InviteMintDeps): Promise<Response> {
  try {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST');

    // A malformed body is a client error, not a crash: fall back to an empty
    // object so the missing `groupId` is refused as a defined 400 by
    // `readGroupId` below, rather than a `SyntaxError` escaping as a 500 (which
    // `/sync` and friends would treat as retryable).
    const parsed = await request.json().catch(() => ({}));
    // A `null` body is valid JSON but not an object; reading `.groupId` off it
    // would throw a TypeError that escapes as a 500. Normalise to an empty object
    // so the field validators below produce a defined 4xx instead.
    const body: MintRequest =
      parsed && typeof parsed === 'object' ? (parsed as MintRequest) : ({} as MintRequest);
    const groupId = readGroupId(body.groupId);
    const caller = deps.asCaller(request);
    const { profileId } = await deps.requireMembership(caller, groupId);
    const service = deps.asService();

    // The live-link cap below is per group, so somebody in many groups can mint
    // as fast as they like across all of them. This is per person.
    await deps.enforceRateLimit(service, request, 'invite-mint', profileId);

    const { count, error: countError } = await service
      .from('invites')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', groupId)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString());
    // Fail closed: a failed count must not read as zero and wave the insert past
    // the cap. Refuse rather than mint an unbounded link.
    if (countError) throw new HttpError(500, 'INTERNAL', countError.message);
    if ((count ?? 0) >= MAX_LIVE_INVITES) {
      throw new HttpError(
        429,
        'TOO_MANY_INVITES',
        'This group already has several live invite links. Revoke one before making another.',
      );
    }

    const days = Math.min(Math.max(finiteOr(body.expiresInDays, 7), 1), MAX_EXPIRY_DAYS);
    const maxUses = Math.min(Math.max(finiteOr(body.maxUses, 25), 1), MAX_USES_LIMIT);

    // 32 bytes of entropy, url-safe. Never stored anywhere in this form.
    const token = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, 43);

    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    const { data: invite, error } = await service
      .from('invites')
      .insert({
        group_id: groupId,
        token_hash: await sha256Hex(token),
        created_by: profileId,
        expires_at: expiresAt,
        max_uses: maxUses,
      })
      .select('id')
      .single();
    if (error) throw new HttpError(500, 'INTERNAL', error.message);

    const { data: group } = await service.from('groups').select('name').eq('id', groupId).single();

    return json({
      inviteId: invite.id,
      token,
      expiresAt,
      maxUses,
      groupName: group?.name ?? 'a group',
    });
  } catch (error) {
    return errorResponse(error, { fn: 'invite-mint' });
  }
}
