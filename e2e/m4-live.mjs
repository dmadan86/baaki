/**
 * The M4 additions, against the deployed project.
 *
 * Everything here has passing tests against a local Postgres already. What
 * those cannot tell you is whether the thing that is *deployed* has them: a
 * migration applied to the wrong database, an RPC that exists but was never
 * granted, an RLS policy that reads differently through PostgREST than through
 * a direct connection. Each of those has happened at least once in this repo,
 * and each time it was a live run that found it.
 *
 * Run: node e2e/m4-live.mjs   (needs ANON_KEY)
 */
import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL ?? 'https://xvjzbpgcmotoahtqcxve.supabase.co';
const ANON = process.env.ANON_KEY;

if (!ANON) {
  console.error('Set ANON_KEY.');
  process.exit(1);
}

const pass = [];
const fail = [];
const check = (label, condition, detail = '') => {
  (condition ? pass : fail).push(label);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const client = createClient(URL, ANON, { auth: { persistSession: false } });
await client.auth.signInAnonymously();

const { data: groupId } = await client.rpc('waves_create_group', {
  p_name: 'M4 live',
  p_type: 'trip',
  p_currency: 'INR',
  p_emoji: null,
  p_simplify: true,
});

const { data: ghostId } = await client.rpc('waves_add_ghost_member', {
  p_group_id: groupId,
  p_name: 'Ravi',
  p_member_id: null,
});
const { data: members } = await client
  .from('group_members')
  .select('id, profile_id')
  .eq('group_id', groupId);
const me = members.find((member) => member.profile_id).id;

// ── trip dates: columns exist and are writable by a member ──────────────────

const dated = await client
  .from('groups')
  .update({
    start_date: '2026-03-10',
    end_date: '2026-03-14',
    time_zone: 'Asia/Kolkata',
    remind_daily: true,
    remind_morning_at: '09:00:00',
    remind_evening_at: '21:00:00',
  })
  .eq('id', groupId)
  .select('start_date, end_date, time_zone, remind_morning_at')
  .single();

check('a group can say when the trip is', !dated.error, dated.error?.message ?? '');
check(
  'and the reminder times come back as they were set',
  dated.data?.remind_morning_at?.startsWith('09:00'),
  JSON.stringify(dated.data),
);

const backwards = await client
  .from('groups')
  .update({ start_date: '2026-03-20', end_date: '2026-03-14' })
  .eq('id', groupId);
check(
  'a trip that ends before it starts is refused',
  Boolean(backwards.error),
  backwards.error?.message ?? 'accepted',
);

// ── an expense to disagree with ─────────────────────────────────────────────

const written = await client.functions.invoke('expense-write', {
  body: {
    groupId,
    expenseDate: '2026-03-11',
    currency: 'INR',
    description: 'Dinner',
    amount: '30000',
    participants: [me, ghostId],
    splitParams: { kind: 'equal' },
    payers: { [me]: '30000' },
    clientMutationId: crypto.randomUUID(),
  },
});
check('an expense still writes after the deploy', !written.error, written.error?.message ?? '');

const expenseId = written.data?.expenseId;

const balancesBefore = await client
  .from('group_balances')
  .select('member_id, balance')
  .eq('group_id', groupId);

// ── declining it ────────────────────────────────────────────────────────────

const raised = await client.rpc('waves_dispute_expense', {
  p_expense_id: expenseId,
  p_reason: 'I was not there',
});
check('an expense can be declined', !raised.error, raised.error?.message ?? '');

const { data: disputes } = await client
  .from('expense_disputes')
  .select('id, status, reason')
  .eq('expense_id', expenseId);
check(
  'the group can see who disagreed and why',
  disputes?.[0]?.status === 'open' && disputes?.[0]?.reason === 'I was not there',
  JSON.stringify(disputes),
);

const balancesAfter = await client
  .from('group_balances')
  .select('member_id, balance')
  .eq('group_id', groupId);
check(
  'and it moves no money at all',
  // The whole design in one assertion. A share anybody could drop on their own
  // would be a debt anybody could delete.
  JSON.stringify(balancesBefore.data) === JSON.stringify(balancesAfter.data),
  JSON.stringify(balancesAfter.data),
);

const selfResolve = await client.rpc('waves_resolve_dispute', {
  p_dispute_id: disputes?.[0]?.id,
  p_accept: true,
  p_note: null,
});
check(
  'nobody rules on their own complaint',
  // The caller here is both the author and the disputer, and the author check
  // must not be what lets them through.
  Boolean(selfResolve.error),
  selfResolve.error?.message ?? 'allowed',
);

const withdrawn = await client.rpc('waves_withdraw_dispute', { p_expense_id: expenseId });
check('a complaint can be taken back', !withdrawn.error, withdrawn.error?.message ?? '');

// ── the fanout is not for clients ───────────────────────────────────────────

const fanout = await client.functions.invoke('notify-fanout', { body: {} });
check(
  'notify-fanout refuses a signed-in caller',
  // It reads other people's inboxes. Anything but a refusal here is a leak.
  Boolean(fanout.error),
  fanout.error?.message ?? 'accepted',
);

// Each of these was callable by any signed-in person on the deployed project,
// while the same assertions passed against a local Postgres: Supabase grants
// EXECUTE to anon and authenticated by default, so revoking from PUBLIC took
// away a grant that was never what let them in. Claiming leaks other people's
// notification text and their device tokens; auto-confirm settles strangers'
// money. This block is the only thing that would have noticed.
for (const [name, args] of [
  ['waves_auto_confirm_settlements', {}],
  ['waves_trip_nudges', {}],
  ['waves_claim_push_notifications', { p_limit: 1 }],
  ['waves_finish_push', {}],
]) {
  const attempt = await client.rpc(name, args);
  check(
    `${name} is not something a signed-in person can run`,
    Boolean(attempt.error),
    attempt.error?.message?.slice(0, 60) ?? 'ALLOWED',
  );
}

// ── cancel / dispute a pending settlement (A50) ─────────────────────────────
// A live run cannot stage a real pending settlement without a second account,
// but it can prove the two hand-transition RPCs are DEPLOYED and grant-reachable
// by an authenticated caller, and that their own party guard runs at all: a
// random id belongs to no settlement, so each must answer with its own NOT_FOUND
// — not PostgREST's "could not find the function", which is exactly how a missing
// migration or a lost grant would show up instead.
for (const [name, args] of [
  ['waves_cancel_settlement', { p_settlement_id: randomUUID() }],
  ['waves_dispute_settlement', { p_settlement_id: randomUUID(), p_reason: null }],
]) {
  const attempt = await client.rpc(name, args);
  check(
    `${name} is deployed and its guard runs`,
    /NOT_FOUND/i.test(attempt.error?.message ?? ''),
    attempt.error?.message?.slice(0, 60) ?? 'ALLOWED',
  );
}

// ── the inbox ───────────────────────────────────────────────────────────────

const inbox = await client.from('notifications').select('id, kind, dedupe_key').limit(5);
check('the inbox reads without error', !inbox.error, inbox.error?.message ?? '');

const tokens = await client.from('push_tokens').select('id').limit(1);
check('push tokens read without error', !tokens.error, tokens.error?.message ?? '');

await client.from('groups').update({ archived_at: new Date().toISOString() }).eq('id', groupId);

console.log(`\n${pass.length}/${pass.length + fail.length} passed`);
if (fail.length > 0) {
  console.log('Failed:', fail.join(', '));
  process.exit(1);
}
