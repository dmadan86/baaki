/**
 * M1 acceptance run against the real Supabase project.
 *
 * Covers the TDR M1 criteria: two devices see each other's expense in under 2s,
 * edit history is visible, a deleted expense is restorable, and every money
 * invariant holds on server-side recomputation.
 */
import { createClient } from '@supabase/supabase-js';
// The same bundle the edge function runs, so client and server agree by construction.
import { computeNetBalances, computeShares, balanceSums } from '../supabase/functions/_shared/core.js';

const URL = process.env.SUPABASE_URL ?? 'https://xvjzbpgcmotoahtqcxve.supabase.co';
const ANON = process.env.ANON_KEY;
const SERVICE = process.env.SERVICE_KEY;

const pass = [];
const fail = [];
const check = (label, condition, detail = '') => {
  (condition ? pass : fail).push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

/** Supabase wraps non-2xx function responses; dig out the server's own code. */
async function describe(error) {
  if (!error) return '';
  const context = error.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json();
      return `${body.code ?? '?'}: ${body.message ?? ''}`;
    } catch {
      try { return await context.text(); } catch { /* fall through */ }
    }
  }
  return error.message ?? String(error);
}

const client = (key) =>
  createClient(URL, key, { auth: { persistSession: false, autoRefreshToken: false } });

const service = createClient(URL, SERVICE, { auth: { persistSession: false } });

// ── 1. auth: anonymous sign-in and the profile trigger ─────────────────────
const alice = client(ANON);
const { data: aliceAuth, error: aliceError } = await alice.auth.signInAnonymously();
check('guest sign-in works (ADR-006)', !aliceError && !!aliceAuth?.user, aliceError?.message ?? '');
const aliceId = aliceAuth.user.id;

let aliceProfile = null;
for (let attempt = 0; attempt < 10 && !aliceProfile; attempt += 1) {
  const { data } = await alice.from('profiles').select('*').eq('id', aliceId).maybeSingle();
  aliceProfile = data;
  if (!aliceProfile) await new Promise((r) => setTimeout(r, 300));
}
check('auth.users trigger created the profile row', !!aliceProfile, aliceProfile?.display_name);

await alice.from('profiles').update({ display_name: 'Asha', default_vpa: 'asha@ybl' }).eq('id', aliceId);

const bob = client(ANON);
const { data: bobAuth } = await bob.auth.signInAnonymously();
const bobId = bobAuth.user.id;
await bob.from('profiles').update({ display_name: 'Bob', default_vpa: 'bob@okaxis' }).eq('id', bobId);

const mallory = client(ANON);
await mallory.auth.signInAnonymously();

// ── 2. group creation, ghosts, membership ──────────────────────────────────
const { data: groupId, error: groupError } = await alice.rpc('waves_create_group', {
  p_name: 'Goa trip',
  p_type: 'trip',
  p_currency: 'INR',
  p_emoji: '🏖️',
  p_simplify: true,
});
check('create group RPC', !groupError && !!groupId, groupError?.message ?? groupId);

const { error: ghostError } = await alice
  .from('group_members')
  .insert({ group_id: groupId, ghost_name: 'Priya', joined_via: 'ghost' });
check('member can add a ghost (ADR-006)', !ghostError, ghostError?.message ?? '');

// Bob joins. The invite flow is M3, so the service role stands in for it here.
await service.from('group_members').insert({ group_id: groupId, profile_id: bobId, joined_via: 'invite_link' });

const { data: members } = await alice.from('group_members').select('id, profile_id, ghost_name').eq('group_id', groupId);
const aliceMember = members.find((m) => m.profile_id === aliceId).id;
const bobMember = members.find((m) => m.profile_id === bobId).id;
const ghostMember = members.find((m) => m.ghost_name === 'Priya').id;
check('group has three members', members.length === 3, `${members.length}`);

// ── 3. RLS: an outsider sees nothing ───────────────────────────────────────
const { data: malloryGroups } = await mallory.from('groups').select('id');
check('outsider cannot see the group (ADR-013)', (malloryGroups ?? []).length === 0);
const { error: malloryWrite } = await mallory.from('expenses').insert({ group_id: groupId });
check('outsider cannot write into the group', !!malloryWrite, malloryWrite?.code ?? '');

// ── 4. realtime: Bob subscribes before Alice writes ────────────────────────
let realtimeAt = null;
const channel = bob
  .channel(`group:${groupId}`)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: `group_id=eq.${groupId}` }, () => {
    realtimeAt ??= Date.now();
  });
await new Promise((resolve, reject) => {
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') resolve();
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(status));
  });
  setTimeout(() => reject(new Error('subscribe timeout')), 20000);
}).then(() => check('realtime channel subscribed', true)).catch((e) => check('realtime channel subscribed', false, e.message));

// ── 5. expense-write: server recomputes the shares ─────────────────────────
const participants = [aliceMember, bobMember, ghostMember];
const amount = 10000n; // ₹100 across three people → 3334 / 3333 / 3333

const writeStart = Date.now();
let writeDone = null;
const { data: written, error: writeError } = await alice.functions.invoke('expense-write', {
  body: {
    groupId,
    description: 'Beach shack dinner',
    expenseDate: '2026-08-04',
    currency: 'INR',
    amount: amount.toString(),
    splitParams: { kind: 'equal' },
    participants,
    payers: { [aliceMember]: amount.toString() },
    clientMutationId: crypto.randomUUID(),
  },
});
writeDone = Date.now();
check('expense-write creates an expense', !writeError && !!written?.expenseId, await describe(writeError));
const expenseId = written?.expenseId;

if (!expenseId) {
  console.log('\ncannot continue without an expense');
  process.exit(1);
}

const expected = computeShares({
  amount,
  currency: 'INR',
  params: { kind: 'equal' },
  participants,
  seed: expenseId,
});
const serverShares = Object.fromEntries(Object.entries(written?.shares ?? {}).map(([k, v]) => [k, BigInt(v)]));
const sharesMatch = [...expected].every(([member, share]) => serverShares[member] === share);
check('server shares match @waves/core exactly', sharesMatch, JSON.stringify(written?.shares));

// Realtime timing. The TDR criterion is about how fast the *other device*
// learns of a committed expense, so measure from the write completing. The
// end-to-end figure (which includes the edge function round trip from here to
// ap-southeast-1, plus any cold start) is reported alongside it.
const deadline = Date.now() + 10000;
while (!realtimeAt && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
const propagation = realtimeAt ? realtimeAt - writeDone : null;
const endToEnd = realtimeAt ? realtimeAt - writeStart : null;
check(
  'second device notified in under 2s of the write landing (TDR M1)',
  propagation !== null && propagation < 2000,
  propagation === null ? 'no event' : `${propagation}ms propagation, ${endToEnd}ms end to end`,
);

// ── 6. the client cannot push a wrong number ───────────────────────────────
const { error: mismatchError } = await alice.functions.invoke('expense-write', {
  body: {
    groupId,
    description: 'Lying client',
    expenseDate: '2026-08-04',
    currency: 'INR',
    amount: '9000',
    splitParams: { kind: 'equal' },
    participants,
    payers: { [aliceMember]: '9000' },
    expectedShares: { [aliceMember]: '9000', [bobMember]: '0', [ghostMember]: '0' },
    clientMutationId: crypto.randomUUID(),
  },
});
check('SHARE_MISMATCH rejects a disagreeing client (TDR §4)', !!mismatchError, await describe(mismatchError));

// ── 7. idempotency ─────────────────────────────────────────────────────────
const replayId = crypto.randomUUID();
const body = {
  groupId,
  description: 'Scooter rental',
  expenseDate: '2026-08-04',
  currency: 'INR',
  amount: '24000',
  splitParams: { kind: 'equal' },
  participants,
  payers: { [bobMember]: '24000' },
  clientMutationId: replayId,
};
const first = await alice.functions.invoke('expense-write', { body });
const second = await alice.functions.invoke('expense-write', { body });
check(
  'replaying a mutation id does not double-post (ADR-005)',
  first.data?.expenseId === second.data?.expenseId && second.data?.replayed === true,
  `${first.data?.expenseId === second.data?.expenseId}`,
);

// ── 8. edit appends a version ──────────────────────────────────────────────
const edit = await alice.functions.invoke('expense-write', {
  body: {
    groupId,
    expenseId,
    description: 'Beach shack dinner (with drinks)',
    expenseDate: '2026-08-04',
    currency: 'INR',
    amount: '15000',
    splitParams: { kind: 'equal' },
    participants,
    payers: { [aliceMember]: '15000' },
    clientMutationId: crypto.randomUUID(),
  },
});
check('editing appends version 2 (ADR-004)', edit.data?.versionNo === 2, `v${edit.data?.versionNo}`);

const { data: versions } = await alice
  .from('expense_versions')
  .select('version_no, description, amount')
  .eq('expense_id', expenseId)
  .order('version_no');
check('both versions are visible in history', versions?.length === 2, versions?.map((v) => `v${v.version_no}:${v.amount}`).join(' '));

// ── 9. delete and restore ──────────────────────────────────────────────────
const balancesOf = async () => {
  const { data } = await alice.from('group_balances').select('member_id, currency, balance').eq('group_id', groupId);
  return new Map((data ?? []).map((row) => [row.member_id, BigInt(row.balance)]));
};

const beforeDelete = await balancesOf();
await alice.rpc('waves_delete_expense', { p_expense_id: expenseId });
const afterDelete = await balancesOf();
check(
  'deleting an expense changes balances',
  (beforeDelete.get(bobMember) ?? 0n) !== (afterDelete.get(bobMember) ?? 0n),
  `${beforeDelete.get(bobMember)} → ${afterDelete.get(bobMember)}`,
);

await alice.rpc('waves_restore_expense', { p_expense_id: expenseId });
const afterRestore = await balancesOf();
check(
  'restoring puts the balance back exactly',
  (afterRestore.get(bobMember) ?? 0n) === (beforeDelete.get(bobMember) ?? 0n),
  `${afterRestore.get(bobMember)}`,
);

// ── 10. settlement: record, wrong-party confirm, payee confirm ─────────────
// Derive the pair from the ledger rather than assuming a direction. Here the
// ghost is the debtor — she has shares but has never paid for anything — which
// is exactly the case a real group hits, and she has no account, so a member
// records the payment on her behalf.
const ledgerEntries = [...afterRestore.entries()];
const [debtor, debtorBalance] = ledgerEntries.reduce((lowest, entry) =>
  entry[1] < lowest[1] ? entry : lowest,
);
const [creditor, creditorBalance] = ledgerEntries.reduce((highest, entry) =>
  entry[1] > highest[1] ? entry : highest,
);
const settleAmount = -debtorBalance < creditorBalance ? -debtorBalance : creditorBalance;

const clientFor = (member) => (member === aliceMember ? alice : member === bobMember ? bob : null);
const creditorClient = clientFor(creditor);
// Somebody in the group who is neither the payer nor the payee.
const bystanderClient = creditor === aliceMember ? bob : alice;

const { data: settlementId, error: settleError } = await alice.rpc('waves_record_settlement', {
  p_group_id: groupId,
  p_from_member_id: debtor,
  p_to_member_id: creditor,
  p_amount: settleAmount.toString(),
  p_method: 'cash',
  p_currency: 'INR',
  p_note: null,
  p_allocations: [],
  p_client_mutation_id: crypto.randomUUID(),
});
check('settlement recorded', !settleError && !!settlementId, settleError?.message ?? `${settleAmount} paise`);

const pendingBalances = await balancesOf();
check(
  'an unconfirmed settlement does not move the headline balance (TDR §3.3)',
  (pendingBalances.get(debtor) ?? 0n) === (afterRestore.get(debtor) ?? 0n),
);

const { error: wrongParty } = await bystanderClient.rpc('waves_confirm_settlement', {
  p_settlement_id: settlementId,
});
check(
  'only the payee can confirm — a bystander cannot (ADR-007)',
  !!wrongParty && /NOT_THE_PAYEE/.test(wrongParty.message ?? ''),
  wrongParty?.message?.slice(0, 60) ?? 'no error raised',
);

const { error: confirmError } = await creditorClient.rpc('waves_confirm_settlement', {
  p_settlement_id: settlementId,
});
check('the payee can confirm', !confirmError, confirmError?.message ?? '');

// ── 11. the invariants, on real data ───────────────────────────────────────
const finalBalances = await balancesOf();
let total = 0n;
for (const value of finalBalances.values()) total += value;
check('balances sum to zero (ADR-004)', total === 0n, `${total}`);
// The settlement was capped at what the creditor was actually owed, so the
// creditor lands on zero and the debtor's remaining debt drops by exactly that
// amount — a partial settlement, which ADR-007 treats as first-class.
check(
  'the settlement moved exactly the amount recorded, no more',
  (finalBalances.get(creditor) ?? 0n) === creditorBalance - settleAmount &&
    (finalBalances.get(debtor) ?? 0n) === debtorBalance + settleAmount,
  `creditor ${creditorBalance} → ${finalBalances.get(creditor) ?? 0n}, debtor ${debtorBalance} → ${finalBalances.get(debtor) ?? 0n}, settled ${settleAmount}`,
);

// Client-side recomputation must equal the server's stored balances.
const { data: rows } = await alice
  .from('expenses')
  .select(`id, deleted_at,
    currentVersion:expense_versions!expenses_current_version_id_fkey (
      currency, amount, expense_date,
      payers:expense_payers ( member_id, amount ),
      shares:expense_shares ( member_id, amount ))`)
  .eq('group_id', groupId);
const { data: settlementRows } = await alice
  .from('settlements')
  .select('id, from_member_id, to_member_id, currency, amount, status, initiated_at')
  .eq('group_id', groupId);

const snapshots = (rows ?? [])
  .filter((row) => row.currentVersion)
  .map((row) => ({
    id: row.id,
    currency: row.currentVersion.currency,
    amount: BigInt(row.currentVersion.amount),
    payers: Object.fromEntries(row.currentVersion.payers.map((p) => [p.member_id, BigInt(p.amount)])),
    shares: Object.fromEntries(row.currentVersion.shares.map((s) => [s.member_id, BigInt(s.amount)])),
    date: row.currentVersion.expense_date,
    deletedAt: row.deleted_at,
  }));
const settlementSnapshots = (settlementRows ?? []).map((row) => ({
  id: row.id,
  from: row.from_member_id,
  to: row.to_member_id,
  currency: row.currency,
  amount: BigInt(row.amount),
  status: row.status,
  at: row.initiated_at,
}));

const recomputed = computeNetBalances(snapshots, settlementSnapshots).get('INR') ?? new Map();
const agree = [...new Set([...recomputed.keys(), ...finalBalances.keys()])].every(
  (member) => (recomputed.get(member) ?? 0n) === (finalBalances.get(member) ?? 0n),
);
check('client recomputation equals the server’s stored balances', agree);
check(
  'recomputed balances also sum to zero',
  [...balanceSums(computeNetBalances(snapshots, settlementSnapshots)).values()].every((v) => v === 0n),
);

// ── 12. activity feed ──────────────────────────────────────────────────────
const { data: activity } = await alice
  .from('activity_log')
  .select('verb, object_type')
  .eq('group_id', groupId)
  .order('created_at');
const verbs = (activity ?? []).map((row) => row.verb);
check(
  'every action is in the activity feed',
  ['created', 'added', 'edited', 'deleted', 'restored', 'settled', 'confirmed'].every((v) => verbs.includes(v)),
  verbs.join(','),
);

await bob.removeChannel(channel);

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) {
  console.log('failures:');
  for (const f of fail) console.log(' -', f);
  process.exit(1);
}
