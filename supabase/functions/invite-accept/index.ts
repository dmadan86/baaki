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

import { GUEST_GROUP_LIMIT, GUEST_TRIAL_DAYS } from '../_shared/core.js';
import {
  asCaller,
  asService,
  serveWithCors,
  errorResponse,
  HttpError,
  json,
} from '../_shared/auth.ts';
import { enforceRateLimit } from '../_shared/rateLimit.ts';

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

serveWithCors(async (request) => {
  try {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST');

    const body = (await request.json()) as AcceptRequest;
    if (!body.token) throw new HttpError(400, 'NO_TOKEN', 'This link is missing its token');

    const service = asService();

    // Before the lookup, not after. Everything below this line is the oracle:
    // one token in, "yes that is a real group" or "no" out. Counting after the
    // answer has been computed would rate-limit nothing that matters.
    //
    // Keyed on the client address because there is no profile yet — preview
    // deliberately answers before anybody signs in (ADR-006), which is exactly
    // what makes it worth guarding.
    await enforceRateLimit(service, request, 'invite-accept');

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
      // FK-hinted: ghost_merges bridges group_members and profiles, so the embed
      // is ambiguous without naming the column.
      .select('id, ghost_name, profile_id, profiles!profile_id ( display_name )')
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

    // Guest ceilings (ADR-006 addendum): a guest holds one group and writes for
    // ten days. Checked after the already-a-member short-circuit, so re-opening
    // a link to a group they are already in is never blocked. A brand-new
    // person joining their first group is under the limit and inside the window,
    // so this only ever stops an existing guest joining a *second* group, or one
    // whose trial has run out. Mirrors the numbers in @waves/core.
    if (user.user.is_anonymous === true) {
      if (
        Date.now() >=
        new Date(user.user.created_at).getTime() + GUEST_TRIAL_DAYS * 24 * 60 * 60 * 1000
      ) {
        throw new HttpError(403, 'GUEST_TRIAL_EXPIRED', 'Sign up to keep using Baaki');
      }
      const { count, error: countError } = await service
        .from('group_members')
        .select('id', { count: 'exact', head: true })
        .eq('profile_id', profileId)
        .is('left_at', null);
      if (countError) throw new HttpError(500, 'INTERNAL', countError.message);
      if ((count ?? 0) >= GUEST_GROUP_LIMIT) {
        throw new HttpError(403, 'GUEST_GROUP_LIMIT', 'Sign up to be in more than one group');
      }
    }

    let memberId: string;

    if (body.claimMemberId) {
      const ghost = (members ?? []).find(
        (member) => member.id === body.claimMemberId && member.profile_id === null,
      );
      if (!ghost) {
        throw new HttpError(400, 'NOT_CLAIMABLE', 'That person has already been claimed');
      }

      // Asking, not taking. This used to hand the ghost over on the spot, which
      // meant anybody holding the link could become "Ravi" and inherit every
      // share and settlement filed under that name. ADR-006 always said the
      // organizer confirms; now something does.
      //
      // Nobody joins here. The claim is decided by an admin through
      // `baaki_decide_member_claim`, and that function — not this one — is
      // where "who may approve this" lives, next to the table it guards.
      //
      // The invite use is NOT reserved here. This function used to call
      // `baaki_consume_invite` before this branch, which burned a `max_uses`
      // slot the instant a claim was tapped — every tap, whether or not an admin
      // ever agreed, so one link could be emptied by repeated ghost-claims with
      // nobody joining. The reservation now lives inside `baaki_request_member_claim`
      // (with the invite id passed below): it spends exactly one use for a
      // genuinely-new claim, and nothing for a repeat (already-pending) or a
      // doomed one — atomically, in the same transaction as the claim row.
      const { data: verdict, error: claimError } = await service.rpc('baaki_request_member_claim', {
        p_group_id: invite.group_id,
        p_member_id: ghost.id,
        p_profile_id: profileId,
        p_name: body.displayName ?? null,
        p_invite_id: invite.id,
      });
      if (claimError) throw new HttpError(500, 'CLAIM_FAILED', claimError.message);
      if (verdict?.reason === 'INVITE_INVALID') {
        throw new HttpError(404, 'INVITE_INVALID', 'This invite link is no longer valid');
      }
      if (!verdict?.ok) {
        throw new HttpError(
          409,
          verdict?.reason ?? 'NOT_CLAIMABLE',
          'That place is no longer free to claim',
        );
      }

      // The name is not written yet: it belongs to somebody who has only said
      // they are that person. It is carried on the claim and applied if and
      // when an admin agrees.
      return json({
        group,
        pending: true,
        claimId: verdict.claim_id,
        alreadyPending: verdict.already_pending === true,
      });
    } else {
      // A direct join, and the one place a use is spent up front: reserve it
      // atomically before creating the membership. A plain read-then-write let
      // two redemptions of the same link race past `max_uses`; this conditional
      // increment lets exactly one of them win the last slot (and re-checks
      // revocation/expiry under the row lock). Placed after the already-a-member
      // and guest-ceiling short-circuits so those never burn a use.
      const { data: consumed, error: consumeError } = await service.rpc('baaki_consume_invite', {
        p_invite_id: invite.id,
      });
      if (consumeError) throw new HttpError(500, 'INTERNAL', consumeError.message);
      if (consumed !== true) {
        throw new HttpError(404, 'INVITE_INVALID', 'This invite link is no longer valid');
      }

      const { data: inserted, error: insertError } = await service
        .from('group_members')
        .insert({ group_id: invite.group_id, profile_id: profileId, joined_via: 'invite_link' })
        .select('id')
        .single();
      if (insertError) throw new HttpError(500, 'INTERNAL', insertError.message);
      memberId = inserted.id;
    }

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
