/**
 * TDR §10's acceptance bar, against the real database:
 * "Splitwise CSV round-trips into correct balances".
 *
 * The word carrying the weight is *balances*. The parser has unit tests and has
 * had since M0; what those cannot show is whether the numbers survive the
 * write — the ghost creation, the reconstruction of payers, the trigger that
 * insists every version's payers and shares both add up to its amount, and the
 * derived `group_balances` the app actually reads. Each of those is a place a
 * paisa can go missing, and none of them run in a unit test.
 *
 * The import is also asserted to be *one* transaction. A half-finished import
 * is the failure nobody can see: the balances still add up, they are simply the
 * balances of a smaller group that never existed.
 */
import { createClient } from '@supabase/supabase-js';

import { importSplitwiseCsv } from '../supabase/functions/_shared/core.js';

const URL = process.env.SUPABASE_URL ?? 'https://xvjzbpgcmotoahtqcxve.supabase.co';
const ANON = process.env.ANON_KEY;

const pass = [];
const fail = [];
const check = (label, condition, detail = '') => {
  (condition ? pass : fail).push(label);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const client = createClient(URL, ANON, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// A file with the shapes that actually break things: a quoted description
// containing a comma, an uneven split that cannot divide cleanly, a row where
// two people paid, a zero row, and the trailing summary line Splitwise appends.
const CSV = [
  'Date,Description,Category,Cost,Currency,Asha,Rahul,Priya',
  '2026-01-04,"Dinner, drinks and a taxi",Food and drink,1000.00,INR,666.67,-333.34,-333.33',
  '2026-01-05,Hostel rent,Home,9000.00,INR,-3000.00,6000.00,-3000.00',
  '2026-01-06,Petrol,Transportation,1000.00,INR,250.00,250.00,-500.00',
  '2026-01-07,Nothing owed,General,0.00,INR,0.00,0.00,0.00',
  'Total balance,,,,,-2083.33,6916.66,-4833.33',
].join('\n');

const parsed = importSplitwiseCsv(CSV);
check('the file parses', parsed.expenses.length === 4, `${parsed.expenses.length} expenses`);
check('every column becomes a person', parsed.people.length === 3, parsed.people.join(', '));
check('the summary row is not imported as an expense', !parsed.expenses.some((e) => /total/i.test(e.description)));

let parsedTotal = 0n;
for (const value of Object.values(parsed.balances)) parsedTotal += value;
check('parsed balances sum to zero', parsedTotal === 0n, `${parsedTotal}`);

// ── sign in and import ─────────────────────────────────────────────────────
const { error: authError } = await client.auth.signInAnonymously();
if (authError) {
  console.error('could not sign in:', authError.message);
  process.exit(1);
}
const me = (await client.auth.getUser()).data.user.id;
await client.from('profiles').update({ display_name: 'Asha' }).eq('id', me);

const { data: groupId, error: groupError } = await client.rpc('waves_create_group', {
  p_name: 'Imported from Splitwise',
  p_type: 'other',
  p_currency: 'INR',
  p_emoji: null,
  p_simplify: false,
});
check('a group to import into', Boolean(groupId), groupError?.message ?? '');

const { data: members } = await client
  .from('group_members')
  .select('id, profile_id, ghost_name')
  .eq('group_id', groupId);
const mine = members.find((member) => member.profile_id === me);

const mutationIds = parsed.expenses.map(() => crypto.randomUUID());
const payload = {
  p_group_id: groupId,
  // Asha is me; Rahul and Priya do not have the app and become ghosts.
  p_people: [
    { name: 'Asha', memberId: mine.id },
    { name: 'Rahul', memberId: null },
    { name: 'Priya', memberId: null },
  ],
  p_expenses: parsed.expenses.map((expense, index) => ({
    clientMutationId: mutationIds[index],
    description: expense.description,
    category: expense.category,
    date: expense.date,
    currency: expense.currency,
    amount: expense.amount.toString(),
    payers: Object.fromEntries(
      Object.entries(expense.payers).map(([name, value]) => [name, value.toString()]),
    ),
    shares: Object.fromEntries(
      Object.entries(expense.shares).map(([name, value]) => [name, value.toString()]),
    ),
  })),
};

const { data: result, error: importError } = await client.rpc('waves_import_splitwise', payload);
check('the import runs', Boolean(result), importError?.message ?? '');
if (!result) {
  console.log(`\n${pass.length} passed, ${fail.length} failed`);
  process.exit(1);
}
check('every expense landed', result.expenses === 4, `${result.expenses}`);
check('the two people without the app became ghosts', result.ghosts === 2, `${result.ghosts}`);

// ── the bar itself ─────────────────────────────────────────────────────────
const nameOf = new Map(Object.entries(result.members).map(([name, id]) => [id, name]));

const { data: balanceRows, error: balanceError } = await client
  .from('group_balances')
  .select('member_id, currency, balance')
  .eq('group_id', groupId);
check('the derived balances are readable', !balanceError, balanceError?.message ?? '');

const live = new Map();
for (const row of balanceRows ?? []) {
  if (row.currency !== 'INR') continue;
  live.set(nameOf.get(row.member_id), BigInt(row.balance));
}
check('every person has a derived balance row', live.size === 3, `${live.size} rows`);

const everyoneAgrees = parsed.people.every(
  (person) => (live.get(person) ?? 0n) === parsed.balances[person],
);
check(
  'the CSV round-trips into correct balances',
  everyoneAgrees,
  parsed.people
    .map((person) => `${person}: file ${parsed.balances[person]} / live ${live.get(person) ?? 0n}`)
    .join(' · '),
);

let liveTotal = 0n;
for (const value of live.values()) liveTotal += value;
check('live balances sum to zero', liveTotal === 0n, `${liveTotal}`);

// ── the properties that only a real write can show ─────────────────────────
const { data: expenseRows } = await client.from('expenses').select('id').eq('group_id', groupId);
const { data: versions, error: versionError } = await client
  .from('expense_versions')
  .select('source')
  .in(
    'expense_id',
    (expenseRows ?? []).map((row) => row.id),
  );
check(
  'every imported row is tagged as imported',
  !versionError && (versions ?? []).length === 4 && versions.every((v) => v.source === 'imported'),
  versionError?.message ?? (versions ?? []).map((v) => v.source).join(', '),
);

// A second tap on Import — or a retry after a dropped response — must replay,
// not duplicate. Same mutation ids, same payload.
const { data: again, error: againError } = await client.rpc('waves_import_splitwise', payload);
check('a repeated import writes nothing new', again?.expenses === 0, againError?.message ?? `${again?.expenses}`);

const { count: expenseCount } = await client
  .from('expenses')
  .select('id', { count: 'exact', head: true })
  .eq('group_id', groupId);
check('and leaves exactly four expenses', expenseCount === 4, `${expenseCount}`);

// All-or-nothing: a payload whose last row names somebody who is not in the
// people list must leave the group exactly as it was.
const { count: beforeCount } = await client
  .from('expenses')
  .select('id', { count: 'exact', head: true })
  .eq('group_id', groupId);

const { error: partialError } = await client.rpc('waves_import_splitwise', {
  p_group_id: groupId,
  p_people: [{ name: 'Asha', memberId: mine.id }],
  p_expenses: [
    {
      clientMutationId: crypto.randomUUID(),
      description: 'Fine on its own',
      category: null,
      date: '2026-02-01',
      currency: 'INR',
      amount: '10000',
      payers: { Asha: '10000' },
      shares: { Asha: '10000' },
    },
    {
      clientMutationId: crypto.randomUUID(),
      description: 'Names a stranger',
      category: null,
      date: '2026-02-02',
      currency: 'INR',
      amount: '10000',
      payers: { Asha: '10000' },
      shares: { Nobody: '10000' },
    },
  ],
});
check('a bad row rejects the whole import', Boolean(partialError), partialError?.message ?? 'it was accepted');

const { count: afterCount } = await client
  .from('expenses')
  .select('id', { count: 'exact', head: true })
  .eq('group_id', groupId);
check(
  'and writes none of it — the import is one transaction',
  afterCount === beforeCount,
  `${beforeCount} before, ${afterCount} after`,
);

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) process.exit(1);
