/**
 * The M2 acceptance criterion, for real (TDR §10):
 *
 *   "Airplane-mode: add 10 expenses on 2 devices, reconnect → identical
 *    balances, no dupes (idempotency), conflicting edit surfaces in feed."
 *
 * The same scenario is a property test in @waves/core against a model server.
 * This one runs it against the deployed `/sync` function and real Postgres,
 * because the two bugs M1 shipped with were both things only a real Supabase
 * could show: an extension that rejects a bare DELETE, and PostgREST's
 * autocommit breaking a deferred constraint trigger.
 *
 * Airplane mode is simulated honestly — the devices simply do not call `/sync`
 * until the "reconnect" step, which is exactly what a queued client does.
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

import { computeShares, computeNetBalances } from '../supabase/functions/_shared/core.js';

const URL = process.env.SUPABASE_URL ?? 'https://xvjzbpgcmotoahtqcxve.supabase.co';
const ANON = process.env.ANON_KEY;
const SERVICE = process.env.SERVICE_KEY;

if (!ANON || !SERVICE) {
  console.error('Set ANON_KEY and SERVICE_KEY.');
  process.exit(2);
}

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

/** A device: a session, a mutation queue and a cursor. Nothing else. */
class Device {
  constructor(name) {
    this.name = name;
    this.supabase = client(ANON);
    this.queue = [];
    this.cursors = {};
    this.rows = new Map();
  }

  async signIn(displayName) {
    const { data, error } = await this.supabase.auth.signInAnonymously();
    if (error) throw new Error(`${this.name}: ${error.message}`);
    this.profileId = data.user.id;
    await this.supabase.from('profiles').update({ display_name: displayName }).eq('id', this.profileId);
    return this.profileId;
  }

  enqueue(kind, groupId, payload) {
    const clientMutationId = randomUUID();
    this.queue.push({
      clientMutationId,
      kind,
      groupId,
      clientCreatedAt: new Date().toISOString(),
      payload,
    });
    return clientMutationId;
  }

  /** Reconnect: push everything queued, pull everything since the cursor. */
  async sync(groupIds = []) {
    const cursors = { ...this.cursors };
    for (const id of groupIds) cursors[id] ??= 0;

    const { data, error } = await this.supabase.functions.invoke('sync', {
      body: { deviceId: this.name, mutations: this.queue, cursors },
    });
    if (error) throw new Error(`${this.name} sync: ${await describe(error)}`);

    const done = new Set(
      data.outcomes.filter((o) => o.status !== 'rejected').map((o) => o.clientMutationId),
    );
    this.queue = this.queue.filter((m) => !done.has(m.clientMutationId));
    this.cursors = { ...this.cursors, ...data.cursors };
    for (const change of data.changes) {
      this.rows.set(`${change.table}:${change.row.id}`, change.row);
    }
    return data;
  }

  expenses(groupId) {
    return [...this.rows.values()].filter(
      (row) => row.group_id === groupId && row.currentVersion !== undefined,
    );
  }

  balances(groupId) {
    const snapshots = this.expenses(groupId)
      .filter((row) => row.deleted_at === null && row.currentVersion)
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
    return computeNetBalances(snapshots, []).get('INR') ?? new Map();
  }
}

// ── two devices, one group ─────────────────────────────────────────────────

const alpha = new Device('alpha');
const beta = new Device('beta');
await alpha.signIn('Asha');
await beta.signIn('Bharath');

// The group is created online by Asha, then Bharath joins it: the offline part
// of the test is the expenses, not the membership.
const groupId = randomUUID();
{
  const { error } = await alpha.supabase.rpc('waves_create_group', {
    p_name: 'Airplane mode',
    p_type: 'trip',
    p_currency: 'INR',
    p_emoji: '✈️',
    p_simplify: true,
    p_group_id: groupId,
  });
  check('a group can be created with a client-chosen id', !error, error?.message);
}

// Replaying the create is free — the whole point of the idempotency key.
{
  const { data, error } = await alpha.supabase.rpc('waves_create_group', {
    p_name: 'Airplane mode',
    p_type: 'trip',
    p_currency: 'INR',
    p_emoji: '✈️',
    p_simplify: true,
    p_group_id: groupId,
  });
  check('replaying the create returns the same group', !error && data === groupId, error?.message);

  const { count } = await service
    .from('group_members')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId);
  check('and does not add a second membership', count === 1, `members=${count}`);
}

const { data: ashaMemberId } = await alpha.supabase.rpc('waves_my_member_id', {
  p_group_id: groupId,
});

// Bharath joins through the invite loop so both devices are real members.
const { data: invite, error: inviteError } = await alpha.supabase.functions.invoke('invite-mint', {
  body: { groupId, expiresInDays: 1 },
});
check('an invite can be minted', !inviteError, await describe(inviteError));

const { error: joinError } = await beta.supabase.functions.invoke('invite-accept', {
  body: { token: invite.token, mode: 'join', displayName: 'Bharath' },
});
check('the second device joins', !joinError, await describe(joinError));

const { data: bharathMemberId } = await beta.supabase.rpc('waves_my_member_id', {
  p_group_id: groupId,
});

const members = [ashaMemberId, bharathMemberId];

// ── airplane mode: ten expenses each, nothing sent ──────────────────────────

const queueExpense = (device, payerMemberId, index, amount) => {
  const expenseId = randomUUID();
  const shares = computeShares({
    amount,
    currency: 'INR',
    params: { kind: 'equal' },
    participants: members,
    seed: expenseId,
  });
  device.enqueue('expense.create', groupId, {
    expenseId,
    description: `${device.name} #${index}`,
    expenseDate: '2026-03-01',
    currency: 'INR',
    amount: amount.toString(),
    splitParams: { kind: 'equal' },
    participants: members,
    payers: { [payerMemberId]: amount.toString() },
    expectedShares: Object.fromEntries([...shares].map(([id, share]) => [id, share.toString()])),
  });
  return expenseId;
};

// Deliberately odd amounts: an even split of 333 paise has a remainder, which
// is where a client and server that seed the rotation differently fall apart.
for (let index = 0; index < 10; index += 1) {
  queueExpense(alpha, ashaMemberId, index, BigInt(333 + index));
  queueExpense(beta, bharathMemberId, index, BigInt(777 + index));
}
check('both devices queued ten expenses offline', alpha.queue.length === 10 && beta.queue.length === 10);

// ── reconnect ───────────────────────────────────────────────────────────────

await alpha.sync([groupId]);
await beta.sync([groupId]);
// A second round each, so both have pulled the other's work.
await alpha.sync([groupId]);
await beta.sync([groupId]);

check('every queued mutation was accepted', alpha.queue.length === 0 && beta.queue.length === 0,
  `alpha=${alpha.queue.length} beta=${beta.queue.length}`);

const { count: expenseCount } = await service
  .from('expenses')
  .select('id', { count: 'exact', head: true })
  .eq('group_id', groupId);
check('twenty expenses exist, not more', expenseCount === 20, `count=${expenseCount}`);

const alphaBalances = alpha.balances(groupId);
const betaBalances = beta.balances(groupId);
const sameBalances =
  alphaBalances.size === betaBalances.size &&
  [...alphaBalances].every(([member, value]) => betaBalances.get(member) === value);
check('the two devices agree on every balance', sameBalances,
  `alpha=${JSON.stringify([...alphaBalances].map(([k, v]) => [k.slice(0, 8), String(v)]))}`);

const total = [...alphaBalances.values()].reduce((sum, value) => sum + value, 0n);
check('balances sum to zero', total === 0n, `sum=${total}`);

// The server's own derived balances must agree with both devices (ADR-004).
const { data: serverBalances } = await service
  .from('group_balances')
  .select('member_id, balance')
  .eq('group_id', groupId);
const serverAgrees = serverBalances.every(
  (row) => (alphaBalances.get(row.member_id) ?? 0n) === BigInt(row.balance),
);
check('and the server agrees with the devices', serverAgrees,
  JSON.stringify(serverBalances.map((r) => [r.member_id.slice(0, 8), r.balance])));

// ── replaying a queue after a crash ─────────────────────────────────────────

{
  const expenseId = randomUUID();
  const amount = 5000n;
  const shares = computeShares({
    amount,
    currency: 'INR',
    params: { kind: 'equal' },
    participants: members,
    seed: expenseId,
  });
  const mutation = {
    clientMutationId: randomUUID(),
    kind: 'expense.create',
    groupId,
    clientCreatedAt: new Date().toISOString(),
    payload: {
      expenseId,
      description: 'Crashed mid-sync',
      expenseDate: '2026-03-02',
      currency: 'INR',
      amount: amount.toString(),
      splitParams: { kind: 'equal' },
      participants: members,
      payers: { [ashaMemberId]: amount.toString() },
      expectedShares: Object.fromEntries([...shares].map(([id, s]) => [id, s.toString()])),
    },
  };

  const first = await alpha.supabase.functions.invoke('sync', {
    body: { deviceId: 'alpha', mutations: [mutation], cursors: {} },
  });
  check('the mutation applies', first.data?.outcomes?.[0]?.status === 'applied',
    JSON.stringify(first.data?.outcomes?.[0]));

  // The app died before it could clear the queue, so it sends the same thing.
  const replay = await alpha.supabase.functions.invoke('sync', {
    body: { deviceId: 'alpha', mutations: [mutation], cursors: {} },
  });
  check('replaying it reports a duplicate, not a second expense',
    replay.data?.outcomes?.[0]?.status === 'duplicate',
    JSON.stringify(replay.data?.outcomes?.[0]));

  const { count } = await service
    .from('expense_versions')
    .select('id', { count: 'exact', head: true })
    .eq('expense_id', expenseId);
  check('and exactly one version was written', count === 1, `versions=${count}`);
}

// ── a conflicting edit ──────────────────────────────────────────────────────

{
  const expenseId = randomUUID();
  const build = (device, memberId, amount, description, baseVersionNo) => {
    const shares = computeShares({
      amount,
      currency: 'INR',
      params: { kind: 'equal' },
      participants: members,
      seed: expenseId,
    });
    return {
      clientMutationId: randomUUID(),
      kind: baseVersionNo ? 'expense.update' : 'expense.create',
      groupId,
      clientCreatedAt: new Date().toISOString(),
      payload: {
        expenseId,
        description,
        expenseDate: '2026-03-03',
        currency: 'INR',
        amount: amount.toString(),
        splitParams: { kind: 'equal' },
        participants: members,
        payers: { [memberId]: amount.toString() },
        expectedShares: Object.fromEntries([...shares].map(([id, s]) => [id, s.toString()])),
        baseVersionNo: baseVersionNo ?? null,
      },
    };
  };

  await alpha.supabase.functions.invoke('sync', {
    body: { deviceId: 'alpha', mutations: [build(alpha, ashaMemberId, 1000n, 'Dinner')], cursors: {} },
  });

  // Both devices edited version 1, each believing it was current.
  const ashaEdit = await alpha.supabase.functions.invoke('sync', {
    body: {
      deviceId: 'alpha',
      mutations: [build(alpha, ashaMemberId, 2000n, "Asha's edit", 1)],
      cursors: {},
    },
  });
  check("the first edit is not a conflict", ashaEdit.data?.outcomes?.[0]?.result?.superseded === false,
    JSON.stringify(ashaEdit.data?.outcomes?.[0]?.result));

  const bharathEdit = await beta.supabase.functions.invoke('sync', {
    body: {
      deviceId: 'beta',
      mutations: [build(beta, bharathMemberId, 3000n, "Bharath's edit", 1)],
      cursors: {},
    },
  });
  check('the second edit is reported as a conflict',
    bharathEdit.data?.outcomes?.[0]?.result?.superseded === true,
    JSON.stringify(bharathEdit.data?.outcomes?.[0]?.result));

  const { data: versions } = await service
    .from('expense_versions')
    .select('version_no, description')
    .eq('expense_id', expenseId)
    .order('version_no');
  check('all three versions survive (ADR-004)', versions.length === 3,
    versions.map((v) => v.description).join(' → '));

  const { data: current } = await service
    .from('expenses')
    .select('current_version_id, currentVersion:expense_versions!expenses_current_version_id_fkey ( description )')
    .eq('id', expenseId)
    .single();
  check('the later receipt wins', current.currentVersion.description === "Bharath's edit",
    current.currentVersion.description);

  const { data: superseded } = await service
    .from('activity_log')
    .select('payload')
    .eq('group_id', groupId)
    .eq('verb', 'superseded')
    .eq('object_id', expenseId);
  check('the losing edit is surfaced in the activity feed', superseded.length === 1);
  check('and names whose edit was replaced',
    superseded[0]?.payload?.supersededAuthorMemberId === ashaMemberId &&
      superseded[0]?.payload?.supersededDescription === "Asha's edit",
    JSON.stringify(superseded[0]?.payload));
}

// ── the cursor ──────────────────────────────────────────────────────────────

{
  // A rename changes nothing a client could pull unless the group moves its own
  // cursor, which is the bug this test exists to keep fixed.
  const before = { ...alpha.cursors };
  await alpha.supabase.from('groups').update({ name: 'Airplane mode, renamed' }).eq('id', groupId);
  const response = await alpha.sync([groupId]);
  const groupChange = response.changes.find((change) => change.table === 'groups');
  check('renaming a group is pullable', Boolean(groupChange), JSON.stringify(before));
  check('and the cursor moved forward', response.cursors[groupId] > (before[groupId] ?? 0),
    `${before[groupId]} → ${response.cursors[groupId]}`);

  // Syncing again with the new cursor must return nothing new for the group.
  const quiet = await alpha.sync([groupId]);
  check('a second pull with an up-to-date cursor returns nothing',
    quiet.changes.length === 0, `changes=${quiet.changes.length}`);
}

// ── a rejection does not poison the batch ───────────────────────────────────

{
  const goodId = randomUUID();
  const goodShares = computeShares({
    amount: 1200n,
    currency: 'INR',
    params: { kind: 'equal' },
    participants: members,
    seed: goodId,
  });

  const { data } = await alpha.supabase.functions.invoke('sync', {
    body: {
      deviceId: 'alpha',
      cursors: {},
      mutations: [
        {
          clientMutationId: randomUUID(),
          kind: 'expense.create',
          groupId,
          clientCreatedAt: new Date().toISOString(),
          payload: {
            expenseId: randomUUID(),
            description: 'Lying about the shares',
            expenseDate: '2026-03-04',
            currency: 'INR',
            amount: '1000',
            splitParams: { kind: 'equal' },
            participants: members,
            payers: { [ashaMemberId]: '1000' },
            // Deliberately wrong: the server must not take the client's word.
            expectedShares: Object.fromEntries(members.map((id) => [id, '900'])),
          },
        },
        {
          clientMutationId: randomUUID(),
          kind: 'expense.create',
          groupId,
          clientCreatedAt: new Date().toISOString(),
          payload: {
            expenseId: goodId,
            description: 'Perfectly fine',
            expenseDate: '2026-03-04',
            currency: 'INR',
            amount: '1200',
            splitParams: { kind: 'equal' },
            participants: members,
            payers: { [ashaMemberId]: '1200' },
            expectedShares: Object.fromEntries(
              [...goodShares].map(([id, s]) => [id, s.toString()]),
            ),
          },
        },
      ],
    },
  });

  check('a client that miscomputes shares is rejected',
    data?.outcomes?.[0]?.status === 'rejected' && data.outcomes[0].code === 'SHARE_MISMATCH',
    JSON.stringify(data?.outcomes?.[0]));
  check('and the rest of the batch still applies', data?.outcomes?.[1]?.status === 'applied',
    JSON.stringify(data?.outcomes?.[1]));
}

// ── a stranger cannot sync into someone else's group ────────────────────────

{
  const mallory = new Device('mallory');
  await mallory.signIn('Mallory');
  const { data } = await mallory.supabase.functions.invoke('sync', {
    body: {
      deviceId: 'mallory',
      cursors: { [groupId]: 0 },
      mutations: [
        {
          clientMutationId: randomUUID(),
          kind: 'expense.create',
          groupId,
          clientCreatedAt: new Date().toISOString(),
          payload: {
            expenseId: randomUUID(),
            description: 'Not mine',
            expenseDate: '2026-03-05',
            currency: 'INR',
            amount: '100',
            splitParams: { kind: 'equal' },
            participants: members,
            payers: { [ashaMemberId]: '100' },
          },
        },
      ],
    },
  });

  check('a non-member is refused', data?.outcomes?.[0]?.status === 'rejected',
    JSON.stringify(data?.outcomes?.[0]));
  check('and pulls nothing from a group they are not in',
    (data?.changes ?? []).length === 0, `changes=${data?.changes?.length}`);
}

// ── clean up ────────────────────────────────────────────────────────────────

await service.from('groups').delete().eq('id', groupId);

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length > 0) {
  console.log('Failed:', fail.join(', '));
  process.exit(1);
}
