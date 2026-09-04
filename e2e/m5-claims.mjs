/**
 * The M5 acceptance criterion that had never actually been run (TDR §10):
 *
 *   "4 users claim items concurrently"
 *
 * `m5-receipts.mjs` claimed this from the moment the milestone was called done,
 * and never tested it. It inserted five rows into `receipt_item_claims` through
 * the **service role**, which bypasses RLS, bypasses every grant, and bypasses
 * `waves_set_item_claim` entirely — the one piece of code that decides whose
 * claim a claim is. Postgres accepting five concurrent inserts from a superuser
 * is not in question. What was never checked is the thing the criterion is
 * about: four people, on four phones, each signed in as themselves. That block
 * has since been deleted from `m5-receipts.mjs`, which now owns the parser and
 * the arithmetic and makes no claim about claiming.
 *
 * The difference is not academic. `receipt_item_claims` has INSERT, UPDATE and
 * DELETE revoked from `anon` and `authenticated`, so the door that test used is
 * one no real client can open. Everything a phone can actually do goes through
 * `waves_set_item_claim`, and that function has authorization logic —
 * membership, ghost-versus-real, whose session this is — none of which the
 * service role ever reaches.
 *
 * So this run has four separate signed-in clients, each having joined through
 * the real invite flow, and every claim is made by the person it belongs to.
 *
 * **The receipt is a fixture, not the subject.** It is inserted with the
 * service role rather than scanned, because the scan costs an Anthropic call
 * and this criterion is about the CRDT and its authorization, not the parser —
 * `m5-receipts.mjs` covers the parser. A model with no credit must not be able
 * to fail this run. Everything under test after that point is done by an
 * ordinary anonymous session with an ordinary anon key.
 *
 * Run: node e2e/m5-claims.mjs   (needs ANON_KEY and SERVICE_KEY)
 */
import { createClient } from '@supabase/supabase-js';

import { computeShares, toItemizedParams } from '../supabase/functions/_shared/core.js';

const URL = process.env.SUPABASE_URL ?? 'https://ywojpnfyxxltvihqmcni.supabase.co';
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
      return JSON.stringify(await context.json());
    } catch {
      /* fall through to the message */
    }
  }
  return error.message ?? String(error);
}

const client = (key) =>
  createClient(URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
const service = client(SERVICE);

/** A signed-in anonymous session with a name, which is what a phone is here. */
async function person(name) {
  const session = client(ANON);
  await session.auth.signInAnonymously();
  const { data } = await session.auth.getUser();
  await session.from('profiles').update({ display_name: name }).eq('id', data.user.id);
  return { name, session, userId: data.user.id };
}

// ── four people, four sessions, one group ──────────────────────────────────
const asha = await person('Asha');
const bharath = await person('Bharath');
const chitra = await person('Chitra');
const dev = await person('Dev');
const everyone = [asha, bharath, chitra, dev];

const { data: groupId, error: groupError } = await asha.session.rpc('waves_create_group', {
  p_name: 'Anjappar',
  p_type: 'other',
  p_currency: 'INR',
  p_emoji: '🍛',
  p_simplify: false,
});
check('a group exists to split a bill in', !groupError && !!groupId, await describe(groupError));

// The other three arrive the way anybody actually arrives: a ghost Asha added,
// an invite link, and a claim. Nothing here is a fixture — it is the M3 growth
// loop, and it is what gives each of them a member row of their own.
for (const who of [bharath, chitra, dev]) {
  await asha.session
    .from('group_members')
    .insert({ group_id: groupId, ghost_name: who.name, joined_via: 'ghost' });
}

const { data: ghostRows } = await asha.session
  .from('group_members')
  .select('id, ghost_name')
  .eq('group_id', groupId)
  .not('ghost_name', 'is', null);
const ghostOf = Object.fromEntries((ghostRows ?? []).map((row) => [row.ghost_name, row.id]));

const { data: invite, error: mintError } = await asha.session.functions.invoke('invite-mint', {
  body: { groupId, expiresInDays: 1 },
});
check('an invite link is minted', !mintError && !!invite?.token, await describe(mintError));

for (const who of [bharath, chitra, dev]) {
  const { error } = await who.session.functions.invoke('invite-accept', {
    body: {
      token: invite.token,
      mode: 'join',
      claimMemberId: ghostOf[who.name],
      displayName: who.name,
    },
  });
  check(`${who.name} joined by claiming their ghost`, !error, await describe(error));
}

// Each person's member id, read through their own session — which also proves
// they can see the group at all.
for (const who of everyone) {
  const { data } = await who.session
    .from('group_members')
    .select('id')
    .eq('group_id', groupId)
    .eq('profile_id', who.userId)
    .maybeSingle();
  who.memberId = data?.id;
}
check(
  'all four are members in their own right',
  everyone.every((who) => !!who.memberId),
  everyone.map((who) => `${who.name}=${who.memberId ? 'yes' : 'no'}`).join(' '),
);
check(
  'and they are four different people, not one row read four times',
  new Set(everyone.map((who) => who.memberId)).size === 4,
);

// ── the bill (fixture — see the header) ────────────────────────────────────
const items = [
  { label: 'Chicken Biryani', qty: 1, unitPrice: 32000, total: 32000, confidence: 1 },
  { label: 'Butter Roti', qty: 2, unitPrice: 4500, total: 9000, confidence: 1 },
  { label: 'Chicken 65', qty: 1, unitPrice: 24000, total: 24000, confidence: 1 },
  { label: 'Filter Coffee', qty: 1, unitPrice: 6000, total: 6000, confidence: 1 },
];
const parsed = {
  merchant: 'Anjappar Chettinad',
  date: '2026-03-01',
  currency: 'INR',
  items: [],
  subtotal: 71000,
  taxes: [
    { label: 'CGST 2.5%', amount: 1775 },
    { label: 'SGST 2.5%', amount: 1775 },
  ],
  serviceCharge: null,
  tip: null,
  discounts: [],
  grandTotal: 74550,
};

const receiptId = crypto.randomUUID();
const { error: receiptError } = await service.from('receipts').insert({
  id: receiptId,
  group_id: groupId,
  source: 'text_paste',
  raw_text: 'fixture',
  parse_status: 'parsed',
  parsed,
  created_by: asha.userId,
});
check('a receipt is waiting to be split', !receiptError, receiptError?.message ?? '');

// Publishing is a real call from a real session: it is what freezes the lines
// so that a claim against index 2 keeps meaning the Chicken 65.
const { error: publishError } = await asha.session.rpc('waves_publish_receipt_items', {
  p_receipt_id: receiptId,
  p_items: items,
});
check('whoever scanned it hands the lines over', !publishError, await describe(publishError));

// ── the criterion: four people, four phones, at once ───────────────────────
//
// Everybody claims their own lines through their own session. Asha and Bharath
// both take the biryani, which is the case worth having: two people claiming
// the same line at the same instant is not a conflict to resolve, it is two
// facts, and the CRDT exists to keep both.
const claims = [
  { who: asha, itemIndex: 0 },
  { who: bharath, itemIndex: 0 },
  { who: chitra, itemIndex: 1 },
  { who: dev, itemIndex: 2 },
  { who: asha, itemIndex: 3 },
];

const results = await Promise.all(
  claims.map(({ who, itemIndex }) =>
    who.session
      .rpc('waves_set_item_claim', {
        p_receipt_id: receiptId,
        p_item_index: itemIndex,
        p_claimed: true,
      })
      .then((result) => ({ who, itemIndex, ...result })),
  ),
);

check(
  'four people claim items concurrently, each signed in as themselves',
  results.every((result) => !result.error),
  results
    .filter((result) => result.error)
    .map((result) => `${result.who.name}#${result.itemIndex}: ${result.error.message}`)
    .join('; '),
);

// The claim has to be recorded against the caller, not against whoever the
// request happened to mention. This is the check the service-role version could
// not make, because with the service role the member id is simply whatever was
// typed into the insert.
check(
  'every claim is attributed to the person who made it',
  results.every((result) => !result.error && result.data?.memberId === result.who.memberId),
  results
    .filter((result) => !result.error && result.data?.memberId !== result.who.memberId)
    .map((result) => `${result.who.name} recorded as ${result.data?.memberId}`)
    .join('; '),
);

const { data: stored } = await service
  .from('receipt_item_claims')
  .select('item_index, member_id, released_at, revision')
  .eq('receipt_id', receiptId);
const live = (stored ?? []).filter((row) => row.released_at === null);
check('every claim landed', live.length === claims.length, `${live.length} of ${claims.length}`);

check(
  'the two people who shared the biryani are both on it',
  live.filter((row) => row.item_index === 0).length === 2,
);

// ── the same line, twice, at the same instant ──────────────────────────────
//
// The convergence property. One person's phone retrying — or two taps racing —
// must leave one row, not two, and must not error. `waves_set_item_claim` does
// it in a single INSERT ... ON CONFLICT so the race is settled by the database
// rather than by whichever client read first.
const racing = await Promise.all(
  Array.from({ length: 4 }, () =>
    chitra.session.rpc('waves_set_item_claim', {
      p_receipt_id: receiptId,
      p_item_index: 1,
      p_claimed: true,
    }),
  ),
);
check(
  'the same claim made four times over does not fail',
  racing.every((result) => !result.error),
  racing.find((result) => result.error)?.error?.message ?? '',
);

const { data: chitraRows } = await service
  .from('receipt_item_claims')
  .select('id, revision')
  .eq('receipt_id', receiptId)
  .eq('item_index', 1)
  .eq('member_id', chitra.memberId);
check(
  'and converges on one row rather than four',
  (chitraRows ?? []).length === 1,
  `${chitraRows?.length}`,
);

// ── what a phone must not be able to do ────────────────────────────────────
const { error: forOther } = await bharath.session.rpc('waves_set_item_claim', {
  p_receipt_id: receiptId,
  p_item_index: 3,
  p_claimed: true,
  p_for_member_id: dev.memberId,
});
check(
  'nobody claims a line on behalf of somebody who has the app',
  !!forOther && /NOT_YOURS/.test(forOther.message ?? ''),
  forOther?.message ?? 'it was allowed',
);

const stranger = await person('Nobody');
const { error: outsiderClaim } = await stranger.session.rpc('waves_set_item_claim', {
  p_receipt_id: receiptId,
  p_item_index: 0,
  p_claimed: true,
});
check(
  'somebody who is not in the group cannot claim at all',
  !!outsiderClaim && /NOT_A_MEMBER/.test(outsiderClaim.message ?? ''),
  outsiderClaim?.message ?? 'it was allowed',
);

// The door the old test used, tried as a real client. If this ever succeeds,
// every check above is decoration: the RPC would no longer be the only way in.
const { error: directWrite } = await dev.session
  .from('receipt_item_claims')
  .insert({ receipt_id: receiptId, item_index: 2, member_id: asha.memberId });
check(
  'the claims table itself is closed to clients (A16)',
  !!directWrite,
  directWrite?.message ?? 'a client wrote to it directly',
);

// ── the lines cannot move under a claim ────────────────────────────────────
const { error: republish } = await asha.session.rpc('waves_publish_receipt_items', {
  p_receipt_id: receiptId,
  p_items: items.slice(0, 3),
});
check(
  'the lines are frozen once anybody has claimed',
  !!republish && /ALREADY_CLAIMING/.test(republish.message ?? ''),
  republish?.message ?? 'the lines were changed under four people',
);

// ── and the money still comes out exact ────────────────────────────────────
const byItem = {};
for (const row of live) {
  (byItem[row.item_index] ??= []).push(row.member_id);
}
const { amount, params } = toItemizedParams({ ...parsed, items }, byItem);
check('the split uses the printed total', amount === 74550n, `${amount}`);

const participants = everyone.map((who) => who.memberId);
const shares = computeShares({
  amount,
  currency: 'INR',
  params,
  participants,
  seed: receiptId,
});
const total = [...shares.values()].reduce((sum, share) => sum + share, 0n);
check('the itemized shares add up to the bill exactly', total === amount, `${total} vs ${amount}`);
check(
  'nobody is left out and nobody is invented',
  shares.size === participants.length,
  `${shares.size} of ${participants.length}`,
);
// Chitra had two rotis; Dev had the Chicken 65, which cost nearly three times
// as much. Who ate what is what decides this, not a headcount.
check(
  'who ate what decides who pays what',
  shares.get(chitra.memberId) < shares.get(dev.memberId),
  `Chitra=${shares.get(chitra.memberId)} Dev=${shares.get(dev.memberId)}`,
);

// ── everybody sees the same bill ───────────────────────────────────────────
// Four phones round a table are only splitting one bill if each of them can
// see the others' taps. A CRDT that converges in the database and is invisible
// to three of the four people is plumbing with no tap.
for (const who of everyone) {
  const { data: seen } = await who.session
    .from('receipt_item_claims')
    .select('item_index, member_id, released_at')
    .eq('receipt_id', receiptId);
  const visible = (seen ?? []).filter((row) => row.released_at === null);
  // Counting rows is not enough: a policy that showed each person only their
  // own claims would still return rows, and the count alone would pass. What
  // has to be true is that they can see *other people's* taps.
  const others = visible.filter((row) => row.member_id !== who.memberId);
  check(
    `${who.name} sees the whole table's claims, not only their own`,
    visible.length === claims.length && others.length > 0,
    `${visible.length} claims, ${others.length} of them somebody else's`,
  );
}

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) {
  console.log(fail.map((label) => `  - ${label}`).join('\n'));
  process.exit(1);
}
