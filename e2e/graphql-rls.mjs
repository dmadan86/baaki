/**
 * Does RLS still hold through GraphQL?
 *
 * This is the question the whole "use pg_graphql instead of a standalone
 * server" decision rests on. `pg_graphql` runs inside Postgres and executes as
 * the calling role, so in principle every policy applies exactly as it does
 * over PostgREST. In principle is not good enough for the thing standing
 * between one group's ledger and everybody else's (ADR-013), so this proves it
 * against the deployed database.
 *
 * A GraphQL endpoint is a much larger attack surface than REST: nested
 * selections traverse foreign keys, so a single query can reach tables the
 * caller never named. Each test below reaches for a different table by a
 * different route.
 */
import { createClient } from '@supabase/supabase-js';

const URL_BASE = process.env.SUPABASE_URL ?? 'https://ywojpnfyxxltvihqmcni.supabase.co';
const ANON = process.env.ANON_KEY;
if (!ANON) {
  console.error('Set ANON_KEY.');
  process.exit(2);
}

const pass = [];
const fail = [];
const check = (label, condition, detail = '') => {
  (condition ? pass : fail).push(label);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

/** Ask the GraphQL endpoint as a specific signed-in user. */
async function gql(session, query, variables = {}) {
  const response = await fetch(`${URL_BASE}/graphql/v1`, {
    method: 'POST',
    headers: {
      apikey: ANON,
      authorization: `Bearer ${session.access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

const signIn = async () => {
  const client = createClient(URL_BASE, ANON, { auth: { persistSession: false } });
  const { data } = await client.auth.signInAnonymously();
  return { client, session: data.session };
};

// ── a member, and a complete stranger ──────────────────────────────────────
const asha = await signIn();
const stranger = await signIn();

await asha.client
  .from('profiles')
  .update({ display_name: 'Asha' })
  .eq('id', asha.session.user.id);

const { data: groupId } = await asha.client.rpc('waves_create_group', {
  p_name: 'Kasol',
  p_type: 'trip',
  p_currency: 'INR',
  p_emoji: '🏔️',
  p_simplify: false,
});
await asha.client
  .from('group_members')
  .insert({ group_id: groupId, ghost_name: 'Ravi', joined_via: 'ghost' });
const { data: members } = await asha.client
  .from('group_members')
  .select('id, ghost_name')
  .eq('group_id', groupId);
const me = members.find((m) => !m.ghost_name).id;
const ravi = members.find((m) => m.ghost_name === 'Ravi').id;

await asha.client.functions.invoke('expense-write', {
  body: {
    groupId,
    description: 'Maggi and chai',
    expenseDate: '2026-08-05',
    currency: 'INR',
    amount: '24000',
    splitParams: { kind: 'equal' },
    participants: [me, ravi],
    payers: { [me]: '24000' },
    clientMutationId: crypto.randomUUID(),
  },
});

// ── the endpoint works at all ──────────────────────────────────────────────
const GROUP_QUERY = `
  query Group($id: UUID!) {
    groupsCollection(filter: { id: { eq: $id } }) {
      edges { node {
        id
        name
        default_currency
        group_membersCollection { edges { node { id ghost_name } } }
        expensesCollection { edges { node {
          id
          expense_versionsCollection { edges { node { description amount currency } } }
        } } }
      } }
    }
  }`;

const mine = await gql(asha.session, GROUP_QUERY, { id: groupId });
check('the GraphQL endpoint answers', !mine.errors, JSON.stringify(mine.errors ?? '').slice(0, 200));

const group = mine.data?.groupsCollection?.edges?.[0]?.node;
check('a member reads their own group', group?.name === 'Kasol', group?.name);
check(
  'and its members, in one query',
  group?.group_membersCollection?.edges?.length === 2,
  `${group?.group_membersCollection?.edges?.length}`,
);

// This is the whole reason for the change: one round trip, exactly the fields
// the screen renders, instead of four REST calls and a client-side join.
const version =
  group?.expensesCollection?.edges?.[0]?.node?.expense_versionsCollection?.edges?.[0]?.node;
check('nested traversal reaches the expense and its version', version?.amount === '24000', JSON.stringify(version));

// ── the part that actually matters ─────────────────────────────────────────
const theirs = await gql(stranger.session, GROUP_QUERY, { id: groupId });
check(
  'a stranger asking for the same group gets nothing',
  (theirs.data?.groupsCollection?.edges ?? []).length === 0,
  JSON.stringify(theirs.data?.groupsCollection ?? theirs.errors).slice(0, 200),
);

// A GraphQL selection walks foreign keys, so a caller can reach tables they
// never named. Each of these is a different route to the same ledger.
const EXPENSES_QUERY = `
  query { expensesCollection { edges { node { id group_id } } } }`;
const strangerExpenses = await gql(stranger.session, EXPENSES_QUERY);
check(
  'a stranger cannot list expenses by going at the table directly',
  (strangerExpenses.data?.expensesCollection?.edges ?? []).length === 0,
  JSON.stringify(strangerExpenses.data?.expensesCollection ?? strangerExpenses.errors).slice(0, 200),
);

const SHARES_QUERY = `
  query { expense_sharesCollection { edges { node { member_id amount } } } }`;
const strangerShares = await gql(stranger.session, SHARES_QUERY);
check(
  'nor read anybody’s shares',
  (strangerShares.data?.expense_sharesCollection?.edges ?? []).length === 0,
  JSON.stringify(strangerShares.data?.expense_sharesCollection ?? strangerShares.errors).slice(0, 200),
);

const BALANCES_QUERY = `
  query { group_balancesCollection { edges { node { member_id balance currency } } } }`;
const strangerBalances = await gql(stranger.session, BALANCES_QUERY);
check(
  'nor the derived balances, which are a separate table with their own policy',
  (strangerBalances.data?.group_balancesCollection?.edges ?? []).length === 0,
  JSON.stringify(strangerBalances.data?.group_balancesCollection ?? strangerBalances.errors).slice(0, 200),
);

const INVITES_QUERY = `query { invitesCollection { edges { node { id token_hash } } } }`;
const strangerInvites = await gql(stranger.session, INVITES_QUERY);
check(
  'and invites stay unreadable — the table nobody may select from',
  (strangerInvites.data?.invitesCollection?.edges ?? []).length === 0,
  JSON.stringify(strangerInvites.data?.invitesCollection ?? strangerInvites.errors).slice(0, 200),
);

// Even the member may not read invite tokens: the policy is select-never for
// everyone, and GraphQL must not be the way around it.
const memberInvites = await gql(asha.session, INVITES_QUERY);
check(
  'not even by a member of the group',
  (memberInvites.data?.invitesCollection?.edges ?? []).length === 0,
  JSON.stringify(memberInvites.data?.invitesCollection ?? memberInvites.errors).slice(0, 200),
);

// ── writes must go through the checked path, not GraphQL ───────────────────
const MUTATION = `
  mutation Forge($groupId: UUID!) {
    insertIntoexpensesCollection(objects: [{ group_id: $groupId }]) {
      records { id }
    }
  }`;
const forged = await gql(stranger.session, MUTATION, { groupId });
const forgedRecords = forged.data?.insertIntoexpensesCollection?.records ?? [];
check(
  'a stranger cannot insert an expense into somebody else’s group',
  forgedRecords.length === 0,
  JSON.stringify(forged.errors ?? forged.data).slice(0, 200),
);

// ── anonymous, with no session at all ──────────────────────────────────────
const anonymous = await fetch(`${URL_BASE}/graphql/v1`, {
  method: 'POST',
  headers: { apikey: ANON, authorization: `Bearer ${ANON}`, 'content-type': 'application/json' },
  body: JSON.stringify({ query: EXPENSES_QUERY }),
}).then((r) => r.json());
check(
  'an unauthenticated caller reads no ledger at all',
  (anonymous.data?.expensesCollection?.edges ?? []).length === 0,
  JSON.stringify(anonymous.data?.expensesCollection ?? anonymous.errors).slice(0, 200),
);

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) {
  console.log(fail.map((label) => `  - ${label}`).join('\n'));
  process.exit(1);
}
