/**
 * invite-mint — turns "let them in" into a link (ADR-006).
 *
 * The raw token exists only in the response and the link. What the database
 * stores is a SHA-256 hash of it, so a leaked `invites` row cannot be replayed
 * into group access, and the table has no SELECT policy at all (TDR §2).
 */

import {
  asCaller,
  asService,
  CORS_HEADERS,
  errorResponse,
  HttpError,
  json,
  requireMembership,
} from '../_shared/auth.ts';
import { enforceRateLimit } from '../_shared/rateLimit.ts';

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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST');

    const body = (await request.json()) as MintRequest;
    const caller = asCaller(request);
    const { profileId } = await requireMembership(caller, body.groupId);
    const service = asService();

    // The live-link cap below is per group, so somebody in many groups can mint
    // as fast as they like across all of them. This is per person.
    await enforceRateLimit(service, request, 'invite-mint', profileId);

    const { count } = await service
      .from('invites')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', body.groupId)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString());
    if ((count ?? 0) >= MAX_LIVE_INVITES) {
      throw new HttpError(
        429,
        'TOO_MANY_INVITES',
        'This group already has several live invite links. Revoke one before making another.',
      );
    }

    const days = Math.min(Math.max(body.expiresInDays ?? 7, 1), MAX_EXPIRY_DAYS);
    const maxUses = Math.min(Math.max(body.maxUses ?? 25, 1), MAX_USES_LIMIT);

    // 32 bytes of entropy, url-safe. Never stored anywhere in this form.
    const token = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, 43);

    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    const { data: invite, error } = await service
      .from('invites')
      .insert({
        group_id: body.groupId,
        token_hash: await sha256Hex(token),
        created_by: profileId,
        expires_at: expiresAt,
        max_uses: maxUses,
      })
      .select('id')
      .single();
    if (error) throw new HttpError(500, 'INTERNAL', error.message);

    const { data: group } = await service
      .from('groups')
      .select('name')
      .eq('id', body.groupId)
      .single();

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
});
