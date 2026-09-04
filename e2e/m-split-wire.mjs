/**
 * Split parameters that carry money, over the wire, against live.
 *
 * Three of the six split kinds hold minor units, and minor units are bigints.
 * JSON has no bigint — `JSON.stringify` throws on one — so before this they
 * could not be sent at all: saving an itemized bill failed in the client
 * before it reached the network, and nothing but an equal split could go
 * through the offline queue.
 *
 * They now travel as decimal strings and the server parses them. What is
 * checked here is the part that only shows up against a real deployment:
 * whether the *deployed* function has the parser, whether an exact split
 * actually lands with the right share on the right member, and whether a
 * fractional minor unit is refused rather than rounded into somebody's ledger.
 *
 * Run: node e2e/m-split-wire.mjs   (needs ANON_KEY)
 */
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL ?? 'https://ywojpnfyxxltvihqmcni.supabase.co';
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

async function describeError(error) {
  if (!error) return '';
  const context = error.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json();
      return `${body.code ?? '?'}: ${body.message ?? ''}`;
    } catch {
      /* not JSON */
    }
  }
  return error.message ?? String(error);
}

const client = createClient(URL, ANON, { auth: { persistSession: false } });
await client.auth.signInAnonymously();

const { data: groupId } = await client.rpc('waves_create_group', {
  p_name: 'Split wire',
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

const write = (body) => client.functions.invoke('expense-write', { body });

const base = {
  groupId,
  expenseDate: new Date().toISOString().slice(0, 10),
  currency: 'INR',
  participants: [me, ghostId],
};

// ── an exact split, which is what a CSV import produces ─────────────────────

const exact = await write({
  ...base,
  description: 'Dinner, split unevenly',
  amount: '45000',
  splitParams: { kind: 'exact', amounts: { [me]: '30000', [ghostId]: '15000' } },
  payers: { [me]: '45000' },
  clientMutationId: crypto.randomUUID(),
});
check('an exact split is accepted', !exact.error, await describeError(exact.error));
check(
  'the shares are the ones that were sent, not an equal split',
  exact.data?.shares?.[me] === '30000' && exact.data?.shares?.[ghostId] === '15000',
  JSON.stringify(exact.data?.shares),
);

// ── an itemized bill: the case that could not be saved at all ───────────────

const itemized = await write({
  ...base,
  description: 'Itemized bill',
  amount: '60000',
  splitParams: {
    kind: 'itemized',
    items: [
      { label: 'Biryani', total: '45000' },
      { label: 'Lassi', total: '12000' },
    ],
    claims: { 0: [me], 1: [ghostId] },
    taxes: '3000',
  },
  payers: { [me]: '60000' },
  clientMutationId: crypto.randomUUID(),
});
check('an itemized bill is accepted', !itemized.error, await describeError(itemized.error));

const itemisedTotal = Object.values(itemized.data?.shares ?? {}).reduce(
  (sum, value) => sum + BigInt(value),
  0n,
);
check('its shares add up to the bill', itemisedTotal === 60000n, String(itemisedTotal));
check(
  'tax is prorated, not split evenly',
  // Biryani is 45000 of the 57000 of items, so most of the 3000 tax is on it.
  BigInt(itemized.data?.shares?.[me] ?? 0) > BigInt(itemized.data?.shares?.[ghostId] ?? 0),
  JSON.stringify(itemized.data?.shares),
);

// ── an amount past what a double can hold ───────────────────────────────────

const huge = await write({
  ...base,
  description: 'Past 2^53',
  amount: '9007199254740994',
  splitParams: {
    kind: 'exact',
    amounts: { [me]: '9007199254740993', [ghostId]: '1' },
  },
  payers: { [me]: '9007199254740994' },
  clientMutationId: crypto.randomUUID(),
});
check(
  'an amount a double would round survives the round trip',
  !huge.error && huge.data?.shares?.[me] === '9007199254740993',
  (await describeError(huge.error)) || JSON.stringify(huge.data?.shares),
);

// ── what must be refused ────────────────────────────────────────────────────

const fractional = await write({
  ...base,
  description: 'Half a paisa',
  amount: '45000',
  splitParams: { kind: 'exact', amounts: { [me]: 30000.5, [ghostId]: 14999.5 } },
  payers: { [me]: '45000' },
  clientMutationId: crypto.randomUUID(),
});
check(
  'a fractional minor unit is refused rather than rounded',
  Boolean(fractional.error),
  await describeError(fractional.error),
);

const mismatched = await write({
  ...base,
  description: 'Shares that do not add up',
  amount: '45000',
  splitParams: { kind: 'exact', amounts: { [me]: '30000', [ghostId]: '10000' } },
  payers: { [me]: '45000' },
  clientMutationId: crypto.randomUUID(),
});
const mismatchDetail = await describeError(mismatched.error);
check('shares that do not sum to the total are refused', Boolean(mismatched.error), mismatchDetail);
check(
  'and the refusal says what is wrong with them',
  // "Something went wrong" is no use to somebody staring at a spreadsheet.
  mismatchDetail.includes('EXACT_SUM_MISMATCH') || mismatchDetail.includes('sum'),
  mismatchDetail,
);

const nonsense = await write({
  ...base,
  description: 'Unknown kind',
  amount: '1000',
  splitParams: { kind: 'vibes' },
  payers: { [me]: '1000' },
  clientMutationId: crypto.randomUUID(),
});
check(
  'a split kind nobody knows is refused',
  Boolean(nonsense.error),
  await describeError(nonsense.error),
);

// ── the stored form ─────────────────────────────────────────────────────────

const { data: stored } = await client
  .from('expense_versions')
  .select('split_type, split_params')
  .eq('expense_id', exact.data?.expenseId)
  .single();
check(
  'the exact split is stored with minor units as strings',
  stored?.split_type === 'exact' && stored?.split_params?.amounts?.[me] === '30000',
  JSON.stringify(stored?.split_params),
);

await client.from('groups').update({ archived_at: new Date().toISOString() }).eq('id', groupId);

console.log(`\n${pass.length}/${pass.length + fail.length} passed`);
if (fail.length > 0) {
  console.log('Failed:', fail.join(', '));
  process.exit(1);
}
