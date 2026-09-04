/**
 * Multi-currency, against the deployed stack (ADR-003).
 *
 * The claim under test is reproducibility: the rate stored on an expense has to
 * convert to the same minor units when read back, and the server has to refuse
 * a rate pointing the wrong way — which is the failure that would otherwise be
 * invisible, because a backwards rate converts confidently and wrongly.
 */
import { createClient } from '@supabase/supabase-js';
import { convertWithRecord, money } from '../supabase/functions/_shared/core.js';

const URL = process.env.SUPABASE_URL ?? 'https://xvjzbpgcmotoahtqcxve.supabase.co';
const ANON = process.env.ANON_KEY;
if (!ANON) { console.error('Set ANON_KEY.'); process.exit(2); }

const pass = [], fail = [];
const check = (l, c, d = '') => { (c ? pass : fail).push(l); console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${d ? ` — ${d}` : ''}`); };
const describe = async (e) => {
  if (!e) return '';
  try { return JSON.stringify(await e.context.json()); } catch { return e.message ?? String(e); }
};

const asha = createClient(URL, ANON, { auth: { persistSession: false } });
await asha.auth.signInAnonymously();

const { data: groupId } = await asha.rpc('waves_create_group', {
  p_name: 'Bali', p_type: 'trip', p_currency: 'INR', p_emoji: '🏝️', p_simplify: false,
});
await asha.from('group_members').insert({ group_id: groupId, ghost_name: 'Ravi', joined_via: 'ghost' });
const { data: rows } = await asha.from('group_members').select('id, ghost_name').eq('group_id', groupId);
const me = rows.find((r) => !r.ghost_name).id;
const ravi = rows.find((r) => r.ghost_name === 'Ravi').id;

// ── fetching a rate ────────────────────────────────────────────────────────
const { data: rate, error: rateError } = await asha.functions.invoke('fx-rate?from=EUR&to=INR', { method: 'GET' });
check('a rate can be fetched', !rateError && !!rate, await describe(rateError));
if (rate) {
  check('it comes back as an exact rational, not a float',
    /^\d+$/.test(rate.num) && /^\d+$/.test(rate.den), `${rate.num}/${rate.den}`);
  check('it says where it came from and when', rate.source === 'ecb' && !!rate.ts, `${rate.source} ${rate.ts}`);
  check('it points the right way', rate.from === 'EUR' && rate.to === 'INR');
}

const { error: sameError } = await asha.functions.invoke('fx-rate?from=INR&to=INR', { method: 'GET' });
check('the same currency twice is refused', !!sameError, await describe(sameError));

const anon = createClient(URL, ANON, { auth: { persistSession: false } });
const { error: openProxy } = await anon.functions.invoke('fx-rate?from=EUR&to=INR', { method: 'GET' });
check('it is not an open currency proxy', !!openProxy, await describe(openProxy));

// ── writing an expense in another currency ─────────────────────────────────
const write = (currency, fx) => asha.functions.invoke('expense-write', {
  body: {
    groupId, description: 'Dinner in Ubud', expenseDate: '2026-08-05',
    currency, amount: '5000', splitParams: { kind: 'equal' },
    participants: [me, ravi], payers: { [me]: '5000' }, fx,
    clientMutationId: crypto.randomUUID(),
  },
});

const typed = { num: '9125', den: '100', from: 'EUR', to: 'INR', ts: '2026-08-05T00:00:00.000Z', source: 'manual' };
const { data: written, error: writeError } = await write('EUR', typed);
check('an expense in another currency saves with its rate', !writeError, await describe(writeError));

if (written) {
  const { data: version } = await asha.from('expense_versions')
    .select('currency, amount, fx').eq('id', written.versionId).single();
  check('the expense stays in the currency it was paid in', version.currency === 'EUR', version.currency);
  check('the rate is stored exactly as sent',
    Object.keys(typed).every((key) => version.fx[key] === typed[key]), JSON.stringify(version.fx));

  // The whole point of storing a rational: this converts identically, later,
  // on a different machine, with no network.
  const converted = convertWithRecord(money(BigInt(version.amount), version.currency), version.fx);
  check('reading it back converts to the same minor units (ADR-003)',
    converted.minor === 456250n && converted.currency === 'INR', `${converted.minor} ${converted.currency}`);

  const { data: balances } = await asha.from('group_balances').select('currency, balance').eq('group_id', groupId);
  // The converted number is for display only. What the ledger carries is EUR,
  // because that is the amount that was actually true (ADR-003).
  check('the ledger keeps a EUR balance, not a converted one',
    balances.every((b) => b.currency === 'EUR') && balances.length > 0, JSON.stringify(balances));
  check('and it still sums to zero, per currency (ADR-004)',
    balances.reduce((sum, b) => sum + BigInt(b.balance), 0n) === 0n, JSON.stringify(balances));
}

// ── rates the server must refuse ───────────────────────────────────────────
const backwards = { ...typed, from: 'INR', to: 'EUR' };
const { error: backwardsError } = await write('EUR', backwards);
const backwardsErrorDetail = await describe(backwardsError);
check('a backwards rate is refused, by its own code', backwardsErrorDetail.includes('FX_DIRECTION'), backwardsErrorDetail);

const { error: pointlessError } = await write('INR', typed);
const pointlessErrorDetail = await describe(pointlessError);
check('a rate on an expense already in the group currency is refused', pointlessErrorDetail.includes('FX_NOT_NEEDED'), pointlessErrorDetail);

const { error: floatError } = await write('EUR', { ...typed, num: 91.25, den: 1 });
const floatErrorDetail = await describe(floatError);
check('a rate sent as a float is refused', floatErrorDetail.includes('FX_NOT_RATIONAL'), floatErrorDetail);

const { error: sourcelessError } = await write('EUR', { ...typed, source: '' });
const sourcelessErrorDetail = await describe(sourcelessError);
check('a rate that will not say where it came from is refused', sourcelessErrorDetail.includes('FX_NO_PROVENANCE'), sourcelessErrorDetail);

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) { console.log(fail.map((l) => `  - ${l}`).join('\n')); process.exit(1); }
