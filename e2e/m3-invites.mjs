/**
 * The ADR-006 growth loop, end to end: invite link → preview without an
 * account → join → claim a ghost and inherit its history.
 *
 * The claim is the part worth being paranoid about: a ghost holds real
 * balances, so claiming must move the whole history atomically and must not be
 * possible twice.
 */
import { createClient } from '@supabase/supabase-js';

import { computeNetBalances } from '../supabase/functions/_shared/core.js';

const URL = process.env.SUPABASE_URL ?? 'https://ywojpnfyxxltvihqmcni.supabase.co';
const ANON = process.env.ANON_KEY;
const SERVICE = process.env.SERVICE_KEY;

const pass = [];
const fail = [];
const check = (label, condition, detail = '') => {
  (condition ? pass : fail).push(label);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function describe(error) {
  if (!error) return '';
  const context = error.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json();
      return `${body.code ?? '?'}: ${body.message ?? ''}`;
    } catch {
      /* fall through */
    }
  }
  return error.message ?? String(error);
}

const client = (key) =>
  createClient(URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
const service = createClient(URL, SERVICE, { auth: { persistSession: false } });

// ── the organiser sets up a group with a ghost who owes money ───────────────
const organiser = client(ANON);
await organiser.auth.signInAnonymously();
await organiser
  .from('profiles')
  .update({ display_name: 'Asha' })
  .eq('id', (await organiser.auth.getUser()).data.user.id);

const { data: groupId } = await organiser.rpc('waves_create_group', {
  p_name: 'Hostel mess',
  p_type: 'home',
  p_currency: 'INR',
  p_emoji: '🍽️',
  p_simplify: false,
});

await organiser
  .from('group_members')
  .insert({ group_id: groupId, ghost_name: 'Rahul', joined_via: 'ghost' });
const { data: members } = await organiser
  .from('group_members')
  .select('id, profile_id, ghost_name')
  .eq('group_id', groupId);
const organiserMember = members.find((m) => m.profile_id).id;
const ghostMember = members.find((m) => m.ghost_name === 'Rahul').id;

const { error: expenseError } = await organiser.functions.invoke('expense-write', {
  body: {
    groupId,
    description: 'Mess bill',
    expenseDate: '2026-08-04',
    currency: 'INR',
    amount: '240000',
    splitParams: { kind: 'equal' },
    participants: [organiserMember, ghostMember],
    payers: { [organiserMember]: '240000' },
    clientMutationId: crypto.randomUUID(),
  },
});
check('set up an expense the ghost owes a share of', !expenseError, await describe(expenseError));

const balancesOf = async () => {
  const { data } = await service
    .from('group_balances')
    .select('member_id, balance')
    .eq('group_id', groupId);
  return new Map((data ?? []).map((row) => [row.member_id, BigInt(row.balance)]));
};
const beforeClaim = await balancesOf();
check(
  'the ghost owes half the bill',
  (beforeClaim.get(ghostMember) ?? 0n) === -120000n,
  `${beforeClaim.get(ghostMember)}`,
);

// ── minting ────────────────────────────────────────────────────────────────
const { data: invite, error: mintError } = await organiser.functions.invoke('invite-mint', {
  body: { groupId, expiresInDays: 7 },
});
check('member can mint an invite link', !mintError && !!invite?.token, await describe(mintError));

const { data: storedInvites } = await service
  .from('invites')
  .select('token_hash')
  .eq('group_id', groupId);
check(
  'only a hash of the token is stored (TDR §2)',
  (storedInvites ?? []).every((row) => row.token_hash !== invite.token),
  storedInvites?.[0]?.token_hash?.slice(0, 16) + '…',
);

const outsider = client(ANON);
await outsider.auth.signInAnonymously();
const { data: leaked } = await outsider.from('invites').select('id');
check('nobody can read the invites table, not even a member', (leaked ?? []).length === 0);

// ── preview works before joining ────────────────────────────────────────────
const { data: preview, error: previewError } = await outsider.functions.invoke('invite-accept', {
  body: { token: invite.token, mode: 'preview' },
});
check(
  'link shows a preview before asking for anything',
  !previewError && preview?.group?.id === groupId,
  await describe(previewError),
);
check(
  'preview offers the ghost as claimable',
  preview?.claimable?.some((c) => c.memberId === ghostMember),
  JSON.stringify(preview?.claimable),
);

const { data: stillHidden } = await outsider.from('expenses').select('id').eq('group_id', groupId);
check('previewing does not grant access to the ledger', (stillHidden ?? []).length === 0);

// ── a bad token gets nothing ───────────────────────────────────────────────
const { error: badToken } = await outsider.functions.invoke('invite-accept', {
  body: { token: 'not-a-real-token', mode: 'preview' },
});
check('an invalid token is refused', !!badToken, await describe(badToken));

// ── joining by claiming the ghost ──────────────────────────────────────────
// invite-accept no longer hands the ghost over on the spot (ADR-006's
// organiser-confirms step, "asking is not taking"): claiming a ghost files a
// pending `member_claims` row and returns { pending, claimId }. Nothing about
// membership or balances moves until an admin decides.
const { data: joined, error: joinError } = await outsider.functions.invoke('invite-accept', {
  body: { token: invite.token, mode: 'join', claimMemberId: ghostMember, displayName: 'Rahul' },
});
check(
  'claiming the ghost files a pending request, not an immediate join',
  !joinError && joined?.pending === true && !!joined?.claimId,
  await describe(joinError),
);

const { data: stillGhost } = await service
  .from('group_members')
  .select('profile_id, ghost_name')
  .eq('id', ghostMember)
  .single();
check(
  'the ghost is untouched while the claim is pending',
  stillGhost?.profile_id === null && stillGhost?.ghost_name === 'Rahul',
  JSON.stringify(stillGhost),
);

// Without a well-formed { pending, claimId } response there is nothing to
// approve — pressing on would throw a raw TypeError on `joined.claimId` and
// bury the real cause. Fail loudly and stop the scenario here instead.
if (!joined?.claimId) {
  check('invite-accept returned a claimId to approve', false, JSON.stringify(joined ?? null));
  console.error('\nCannot approve a claim without a claimId — stopping.');
  process.exit(1);
}

// The organiser is the group's admin — approve it the way the app's admin
// screen would, through the same RPC invite-accept used to run inline.
const { data: decision, error: decisionError } = await organiser.rpc('waves_decide_member_claim', {
  p_claim_id: joined.claimId,
  p_approve: true,
});
check(
  'the organiser approves the claim',
  !decisionError && decision?.ok === true && decision?.status === 'approved',
  decisionError?.message ?? JSON.stringify(decision),
);

const afterClaim = await balancesOf();
check(
  'the claimed history carries over untouched (ADR-006)',
  (afterClaim.get(ghostMember) ?? 0n) === (beforeClaim.get(ghostMember) ?? 0n),
  `${beforeClaim.get(ghostMember)} → ${afterClaim.get(ghostMember)}`,
);

const { data: nowVisible } = await outsider.from('expenses').select('id').eq('group_id', groupId);
check('the claimant can now see the group ledger', (nowVisible ?? []).length === 1);

const { data: claimedRow } = await service
  .from('group_members')
  .select('profile_id, ghost_name, joined_via')
  .eq('id', ghostMember)
  .single();
check(
  'the ghost is now a real member, not a duplicate',
  claimedRow?.profile_id !== null && claimedRow?.ghost_name === null,
  claimedRow?.joined_via,
);

const { data: memberCount } = await service
  .from('group_members')
  .select('id')
  .eq('group_id', groupId);
check(
  'claiming did not create an extra member',
  (memberCount ?? []).length === 2,
  `${memberCount?.length}`,
);

// ── the same ghost cannot be claimed twice ─────────────────────────────────
const secondComer = client(ANON);
await secondComer.auth.signInAnonymously();
const { error: doubleClaim } = await secondComer.functions.invoke('invite-accept', {
  body: { token: invite.token, mode: 'join', claimMemberId: ghostMember },
});
check('a claimed ghost cannot be claimed again', !!doubleClaim, await describe(doubleClaim));

// ── joining fresh (no claim) ───────────────────────────────────────────────
const { data: freshJoin, error: freshError } = await secondComer.functions.invoke('invite-accept', {
  body: { token: invite.token, mode: 'join' },
});
check(
  'a new person can join without claiming anyone',
  !freshError && !!freshJoin?.memberId,
  await describe(freshError),
);

// ── revocation ─────────────────────────────────────────────────────────────
const { data: inviteRow } = await service
  .from('invites')
  .select('id')
  .eq('group_id', groupId)
  .single();
await service
  .from('invites')
  .update({ revoked_at: new Date().toISOString() })
  .eq('id', inviteRow.id);

const lateComer = client(ANON);
await lateComer.auth.signInAnonymously();
const { error: revokedError } = await lateComer.functions.invoke('invite-accept', {
  body: { token: invite.token, mode: 'preview' },
});
check('a revoked link stops working immediately', !!revokedError, await describe(revokedError));

// ── the ledger still adds up after all of that ─────────────────────────────
const finalBalances = await balancesOf();
let total = 0n;
for (const value of finalBalances.values()) total += value;
check('balances still sum to zero after the claim', total === 0n, `${total}`);

const { data: rows } = await service
  .from('expenses')
  .select(
    `id, deleted_at,
    currentVersion:expense_versions!expenses_current_version_id_fkey (
      currency, amount, expense_date,
      payers:expense_payers ( member_id, amount ),
      shares:expense_shares ( member_id, amount ))`,
  )
  .eq('group_id', groupId);
const snapshots = (rows ?? [])
  .filter((r) => r.currentVersion)
  .map((row) => ({
    id: row.id,
    currency: row.currentVersion.currency,
    amount: BigInt(row.currentVersion.amount),
    payers: Object.fromEntries(
      row.currentVersion.payers.map((p) => [p.member_id, BigInt(p.amount)]),
    ),
    shares: Object.fromEntries(
      row.currentVersion.shares.map((s) => [s.member_id, BigInt(s.amount)]),
    ),
    date: row.currentVersion.expense_date,
    deletedAt: row.deleted_at,
  }));
const recomputed = computeNetBalances(snapshots, []).get('INR') ?? new Map();
const agree = [...new Set([...recomputed.keys(), ...finalBalances.keys()])].every(
  (member) => (recomputed.get(member) ?? 0n) === (finalBalances.get(member) ?? 0n),
);
check('client recomputation still matches the server', agree);

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) process.exit(1);
