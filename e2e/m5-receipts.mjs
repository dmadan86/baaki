/**
 * The M5 acceptance criterion, against the deployed `receipt-parse` (TDR §10):
 *
 *   "English + Tamil + pasted-text bills parse and reconcile; 4 users claim
 *    items concurrently; itemized expense math exact; export re-imports
 *    losslessly."
 *
 * This file owns the parser and the arithmetic on top of it. The parts that can
 * be proved without a model are already property tests in @baaki/core. What
 * only a real run can show is whether Claude actually reads a Tamil bill,
 * whether it returns paise rather than rupees, and — the one that matters most
 * — whether it leaves a receipt's own arithmetic alone instead of helpfully
 * correcting it. A model that silently fixes a bad total defeats the entire
 * reconciliation check downstream of it.
 *
 * **Claiming is not tested here; `m5-claims.mjs` tests it.** This file used to
 * carry a check called "four people claim items concurrently", and it was not
 * true. It inserted into `receipt_item_claims` with the **service role**, which
 * bypasses RLS, bypasses the grants, and never calls `baaki_set_item_claim` —
 * the function that decides whose claim a claim is. That table has INSERT,
 * UPDATE and DELETE revoked from `anon` and `authenticated`, so the check drove
 * a door no phone can open, and what it demonstrated was that Postgres accepts
 * concurrent inserts from a superuser. It has been removed rather than left to
 * be read as evidence.
 *
 * The itemized arithmetic below stays, because it is about this file's subject:
 * given a bill the model parsed and a map of who claimed what, the shares have
 * to come out exact. That map is written here rather than round-tripped through
 * the database — the sum does not care where the claims were stored, and
 * fetching them back was only ever scaffolding for the check that has gone.
 *
 * Needs ANON_KEY only. Everything here is what an ordinary signed-in phone can
 * do, which is the whole point.
 */
import { createClient } from '@supabase/supabase-js';

import {
  checkReceipt,
  computeShares,
  toItemizedParams,
} from '../supabase/functions/_shared/core.js';

const URL = process.env.SUPABASE_URL ?? 'https://xvjzbpgcmotoahtqcxve.supabase.co';
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

async function describe(error) {
  if (!error) return '';
  const context = error.context;
  if (context && typeof context.json === 'function') {
    try {
      return JSON.stringify(await context.json());
    } catch {
      /* fall through to the message */
    }
  }
  return error.message ?? String(error);
}

const client = (key) => createClient(URL, key, { auth: { persistSession: false } });

// ── a group with four people, because four have to claim at once ───────────
const asha = client(ANON);
await asha.auth.signInAnonymously();
await asha
  .from('profiles')
  .update({ display_name: 'Asha' })
  .eq('id', (await asha.auth.getUser()).data.user.id);

const { data: groupId, error: groupError } = await asha.rpc('baaki_create_group', {
  p_name: 'Anjappar',
  p_type: 'other',
  p_currency: 'INR',
  p_emoji: '🍛',
  p_simplify: false,
});
check('a group exists to scan into', !groupError && !!groupId, await describe(groupError));

for (const name of ['Bharath', 'Chitra', 'Dev']) {
  await asha
    .from('group_members')
    .insert({ group_id: groupId, ghost_name: name, joined_via: 'ghost' });
}
const { data: memberRows } = await asha
  .from('group_members')
  .select('id, profile_id, ghost_name')
  .eq('group_id', groupId);
const members = Object.fromEntries(memberRows.map((row) => [row.ghost_name ?? 'Asha', row.id]));
check(
  'four people are in the group',
  Object.keys(members).length === 4,
  Object.keys(members).join(', '),
);

// ── the bills ──────────────────────────────────────────────────────────────
// Written the way a real one prints: rupees with paise, tax as a line, and a
// grand total the parser has to arrive at independently.
const englishBill = `
ANJAPPAR CHETTINAD
Bill No 4471       01/03/2026
--------------------------------
1 x Chicken Biryani      320.00
2 x Butter Roti           90.00
1 x Chicken 65           240.00
1 x Filter Coffee         60.00
--------------------------------
Subtotal                 710.00
CGST 2.5%                 17.75
SGST 2.5%                 17.75
--------------------------------
TOTAL                    745.50
`.trim();

const tamilBill = `
சரவணா பவன்
ரசீது எண் 118      01/03/2026
--------------------------------
2 x தோசை                 120.00
1 x இட்லி                  40.00
1 x பொங்கல்                 80.00
2 x காபி                   60.00
--------------------------------
கூட்டுத்தொகை              300.00
ஜிஎஸ்டி 5%                 15.00
--------------------------------
மொத்தம்                   315.00
`.trim();

// A bill whose printed total does not match its own lines. The model must
// return it as printed; the reconciliation check, not the model, is what
// catches it.
const wrongBill = `
SWIGGY ORDER #99213
1 x Paneer Tikka         280.00
1 x Naan                  60.00
GST                       17.00
TOTAL                    557.00
`.trim();

async function scan(rawText, label) {
  const started = Date.now();
  const { data, error } = await asha.functions.invoke('receipt-parse', {
    body: { groupId, rawText, source: 'text_paste', currency: 'INR' },
  });
  if (error) {
    check(label, false, await describe(error));
    return null;
  }
  console.log(`      (${Date.now() - started}ms, ${data.parsed.items.length} items)`);
  return data;
}

// ── English ────────────────────────────────────────────────────────────────
const english = await scan(englishBill, 'an English bill parses');
if (english) {
  check('an English bill parses', true);
  check(
    'it reads the printed grand total, in paise',
    english.parsed.grandTotal === 74550,
    `${english.parsed.grandTotal}`,
  );
  check('it finds every line', english.parsed.items.length === 4, `${english.parsed.items.length}`);
  check('it reconciles', english.check.reconciles, `difference=${english.check.difference}`);
  check(
    'the server did the checking, not the client',
    typeof english.check.reconciles === 'boolean' && Array.isArray(english.check.problems),
  );
  // The same arithmetic re-run locally must agree — the response is not trusted
  // on its own, and a mismatch here would mean the two ran different code.
  const local = checkReceipt(english.parsed);
  check(
    'the check is reproducible from the parsed receipt alone',
    local.reconciles === english.check.reconciles && local.difference === english.check.difference,
    `${local.difference} vs ${english.check.difference}`,
  );
}

// ── Tamil ──────────────────────────────────────────────────────────────────
const tamil = await scan(tamilBill, 'a Tamil bill parses');
if (tamil) {
  check('a Tamil bill parses', true);
  check(
    'it reads the Tamil grand total',
    tamil.parsed.grandTotal === 31500,
    `${tamil.parsed.grandTotal}`,
  );
  check(
    'it finds every Tamil line',
    tamil.parsed.items.length === 4,
    `${tamil.parsed.items.length}`,
  );
  check('it reconciles', tamil.check.reconciles, `difference=${tamil.check.difference}`);
  check(
    'the item labels survive in Tamil, not transliterated',
    tamil.parsed.items.some((item) => /[஀-௿]/.test(item.label)),
    tamil.parsed.items.map((i) => i.label).join(', '),
  );
}

// ── a bill that does not add up ────────────────────────────────────────────
const wrong = await scan(wrongBill, 'a bill that does not add up still parses');
if (wrong) {
  check('a bill that does not add up still parses', true);
  check(
    'the model returns the total as printed rather than correcting it',
    wrong.parsed.grandTotal === 55700,
    `${wrong.parsed.grandTotal}`,
  );
  check(
    'and the arithmetic — not the model — catches it',
    !wrong.check.reconciles,
    `difference=${wrong.check.difference}`,
  );
  check(
    'the person is told what to look at',
    wrong.check.problems.length > 0,
    wrong.check.problems[0]?.message,
  );
}

// ── the itemized split is exact ────────────────────────────────────────────
if (english?.check.reconciles) {
  const receiptId = english.receiptId;
  check('the scan was recorded', !!receiptId, `${receiptId}`);

  // Who ate what. Written here rather than claimed through the database:
  // whether these people can *make* these claims is `m5-claims.mjs`'s subject,
  // and this sum is the same sum wherever the map came from. Asha and Bharath
  // share the biryani, so item 0 has two names against it.
  const byItem = {
    0: [members.Asha, members.Bharath],
    1: [members.Chitra],
    2: [members.Dev],
    3: [members.Asha],
  };
  const { amount, params } = toItemizedParams(english.parsed, byItem);
  check('the split uses the printed total', amount === 74550n, `${amount}`);

  const participants = Object.values(members);
  const shares = computeShares({
    amount,
    currency: 'INR',
    params,
    participants,
    seed: receiptId,
  });
  const total = [...shares.values()].reduce((sum, share) => sum + share, 0n);
  check(
    'the itemized shares add up to the bill exactly',
    total === amount,
    `${total} vs ${amount}`,
  );
  check(
    'nobody is left out and nobody is invented',
    shares.size === participants.length,
    `${shares.size} of ${participants.length}`,
  );
  // Asha had half a biryani and the coffee; Dev had only the Chicken 65.
  check(
    'who ate what decides who pays what',
    shares.get(members.Chitra) < shares.get(members.Dev),
    `Chitra=${shares.get(members.Chitra)} Dev=${shares.get(members.Dev)}`,
  );
}

// ── the quota is real ──────────────────────────────────────────────────────
const { data: quota, error: quotaError } = await asha.rpc('baaki_receipt_scan_quota');
check('the scan quota is readable', !quotaError, await describe(quotaError));
check('scans were metered (ADR-011)', (quota?.used ?? 0) >= 3, JSON.stringify(quota));
check(
  'the free ledger is untouched by the quota',
  (quota?.limit ?? 0) === 20,
  JSON.stringify(quota),
);

// ── nobody else's group ────────────────────────────────────────────────────
const outsider = client(ANON);
await outsider.auth.signInAnonymously();
const { error: refused } = await outsider.functions.invoke('receipt-parse', {
  body: { groupId, rawText: englishBill, source: 'text_paste', currency: 'INR' },
});
check('a non-member cannot spend the group scanning bills', !!refused, await describe(refused));

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) {
  console.log(fail.map((label) => `  - ${label}`).join('\n'));
  process.exit(1);
}
