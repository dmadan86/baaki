/**
 * invite-accept — the other half of the growth loop (ADR-006).
 *
 * Two modes, both authorized purely by possession of a valid token:
 *  - `preview` (GET-ish): what group is this, who is already in it, and which
 *    ghosts could be me? Callable by anyone holding the link, so the join
 *    screen can show something real before asking for an account.
 *  - `join`: add the caller as a member. If they name a ghost, that ghost is
 *    claimed instead — its whole history becomes theirs, atomically, and the
 *    ghost row stops existing as a separate participant.
 *
 * Claiming runs service-role-only, which is the entire reason this is an edge
 * function rather than an RLS-guarded insert (ADR-013).
 */

import {
  asCaller,
  asService,
  CORS_HEADERS,
  errorResponse,
  HttpError,
  json,
} from '../_shared/auth.ts';

interface AcceptRequest {
  token: string;
  mode?: 'preview' | 'join';
  /** Optional ghost to claim instead of joining as a new person. */
  claimMemberId?: string | null;
  displayName?: string | null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST');

    const body = (await request.json()) as AcceptRequest;
    if (!body.token) throw new HttpError(400, 'NO_TOKEN', 'This link is missing its token');

    const service = asService();
    const { data: invite, error } = await service
      .from('invites')
      .select('id, group_id, expires_at, revoked_at, max_uses, use_count')
      .eq('token_hash', await sha256Hex(body.token))
      .maybeSingle();
    if (error) throw new HttpError(500, 'INTERNAL', error.message);

    // One message for every failure mode: a probing caller learns nothing about
    // which links exist.
    if (
      !invite ||
      invite.revoked_at ||
      new Date(invite.expires_at) < new Date() ||
      invite.use_count >= invite.max_uses
    ) {
      throw new HttpError(404, 'INVITE_INVALID', 'This invite link is no longer valid');
    }

    const { data: group } = await service
      .from('groups')
      .select('id, name, cover_emoji, default_currency')
      .eq('id', invite.group_id)
      .single();

    const { data: members } = await service
      .from('group_members')
      .select('id, ghost_name, profile_id, profiles ( display_name )')
      .eq('group_id', invite.group_id)
      .is('left_at', null);

    const claimable = (members ?? [])
      .filter((member) => member.profile_id === null)
      .map((member) => ({ memberId: member.id, name: member.ghost_name }));

    if (body.mode !== 'join') {
      return json({
        group,
        memberCount: members?.length ?? 0,
        claimable,
      });
    }

    // Joining needs an identity — anonymous counts (ADR-006).
    const caller = asCaller(request);
    const { data: user, error: userError } = await caller.auth.getUser();
    if (userError || !user?.user) {
      throw new HttpError(401, 'NOT_AUTHENTICATED', 'Sign in (or continue as a guest) first');
    }
    const profileId = user.user.id;

    const existing = (members ?? []).find((member) => member.profile_id === profileId);
    if (existing) {
      return json({ group, memberId: existing.id, alreadyMember: true });
    }

    let memberId: string;

    if (body.claimMemberId) {
      const ghost = (members ?? []).find(
        (member) => member.id === body.claimMemberId && member.profile_id === null,
      );
      if (!ghost) {
        throw new HttpError(400, 'NOT_CLAIMABLE', 'That person has already been claimed');
      }

      // The claim itself: the ghost row becomes this person's membership, so
      // every share, payment and settlement already attached to it carries over
      // untouched. No rows move, so nothing can be lost in the middle.
      const { error: claimError } = await service
        .from('group_members')
        .update({
          profile_id: profileId,
          ghost_name: null,
          joined_via: 'invite_link_claim',
        })
        .eq('id', ghost.id)
        .is('profile_id', null); // loses safely if two people claim at once
      if (claimError) throw new HttpError(409, 'CLAIM_FAILED', claimError.message);
      memberId = ghost.id;

      if (body.displayName) {
        await service
          .from('profiles')
          .update({ display_name: body.displayName })
          .eq('id', profileId);
      }
    } else {
      const { data: inserted, error: insertError } = await service
        .from('group_members')
        .insert({ group_id: invite.group_id, profile_id: profileId, joined_via: 'invite_link' })
        .select('id')
        .single();
      if (insertError) throw new HttpError(500, 'INTERNAL', insertError.message);
      memberId = inserted.id;
    }

    await service
      .from('invites')
      .update({ use_count: invite.use_count + 1 })
      .eq('id', invite.id);

    await service.from('activity_log').insert({
      group_id: invite.group_id,
      actor_member_id: memberId,
      verb: body.claimMemberId ? 'claimed' : 'joined',
      object_type: 'member',
      object_id: memberId,
      payload: { via: 'invite_link' },
    });

    return json({ group, memberId, claimed: Boolean(body.claimMemberId) });
  } catch (error) {
    return errorResponse(error, { fn: 'invite-accept' });
  }
});
