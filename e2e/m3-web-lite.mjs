/**
 * M3's acceptance criterion, against the live project:
 *
 *   "Guest opens link in browser, adds an expense with no install."
 *
 * The point of running this rather than trusting the screens is that the
 * browser path is a *different client* from the app — its own Supabase session,
 * its own reads, no offline mirror — and the thing that must hold across both
 * is that RLS decides what is visible, not the code that happens to be asking.
 * So this exercises `@baaki/api-client` exactly as `apps/web-lite` does, and
 * then checks the two things a screen cannot check for itself: that a stranger
 * with the same anon key sees nothing, and that the guest's account is the
 * same account after they add credentials to it.
 *
 * Run: node e2e/m3-web-lite.mjs   (needs ANON_KEY)
 */
import { createClient } from '@supabase/supabase-js';

import { computeNetBalances } from '../supabase/functions/_shared/core.js';

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

/** A fresh browser: its own session, nothing shared with the last one. */
const browser = () =>
  createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

// ── the host: somebody who already has the app ──────────────────────────────

const host = browser();
{
  const { error } = await host.auth.signInAnonymously();
  if (error) {
    console.error('Could not create the host account:', error.message);
    process.exit(1);
  }
}

const { data: groupId, error: groupError } = await host.rpc('baaki_create_group', {
  p_name: 'Goa',
  p_type: 'trip',
  p_currency: 'INR',
  p_emoji: '🏖️',
  p_simplify: true,
});
check('host creates a group', !groupError, groupError?.message);

// A ghost, because that is the normal case: the trip is already half planned
// before the person you are inviting has heard of the app (ADR-006).
const { data: ghostId, error: ghostError } = await host.rpc('baaki_add_ghost_member', {
  p_group_id: groupId,
  p_name: 'Ravi',
  p_member_id: null,
});
check('host adds Ravi as a ghost', !ghostError, ghostError?.message);

const { data: minted, error: mintError } = await host.functions.invoke('invite-mint', {
  body: { groupId, expiresInDays: 7 },
});
check('host mints a link', !mintError && Boolean(minted?.token), await describeError(mintError));
const token = minted?.token;

// ── the guest: a browser with nothing installed ─────────────────────────────

const guest = browser();

// 1. The link is readable before committing to anything. No account yet.
const { data: preview, error: previewError } = await guest.functions.invoke('invite-accept', {
  body: { token, mode: 'preview' },
});
check(
  'link previews with no account at all',
  !previewError && preview?.group?.id === groupId,
  await describeError(previewError),
);
check(
  'preview offers Ravi to claim',
  (preview?.claimable ?? []).some((person) => person.memberId === ghostId),
  JSON.stringify(preview?.claimable ?? []),
);

// 2. Joining. Guest account first, then the invite against it — the order the
//    web-lite join screen uses.
const { error: guestSignIn } = await guest.auth.signInAnonymously();
check('guest account is created in the browser', !guestSignIn, guestSignIn?.message);

const {
  data: { session: guestSession },
} = await guest.auth.getSession();
const guestUserId = guestSession?.user?.id;
check('the guest account is anonymous', guestSession?.user?.is_anonymous === true);

const { data: accepted, error: acceptError } = await guest.functions.invoke('invite-accept', {
  body: { token, mode: 'join', claimMemberId: ghostId },
});
check(
  'guest joins and claims Ravi',
  !acceptError && accepted?.claimed === true && accepted?.memberId === ghostId,
  await describeError(acceptError),
);

// 3. Reading the group — what apps/web-lite/src/app/g/[groupId] does.
const { data: readGroup } = await guest
  .from('groups')
  .select('id, name, default_currency')
  .eq('id', groupId);
check('guest can read the group', (readGroup ?? []).length === 1);

const { data: readMembers } = await guest
  .from('group_members')
  .select('id, profile_id, ghost_name, profile:profiles ( display_name )')
  .eq('group_id', groupId)
  .is('left_at', null);
check(
  'guest can read the members',
  (readMembers ?? []).length === 2,
  `${readMembers?.length} rows`,
);

// 4. Adding an expense with nothing installed. The whole point.
const hostMemberId = (readMembers ?? []).find((member) => member.id !== ghostId)?.id;
const { data: written, error: writeError } = await guest.functions.invoke('expense-write', {
  body: {
    groupId,
    description: 'Auto to the beach',
    expenseDate: new Date().toISOString().slice(0, 10),
    currency: 'INR',
    amount: '30000',
    splitParams: { kind: 'equal' },
    participants: [ghostId, hostMemberId],
    payers: { [ghostId]: '30000' },
    clientMutationId: crypto.randomUUID(),
  },
});
check(
  'guest adds an expense from the browser',
  !writeError && Boolean(written?.expenseId),
  await describeError(writeError),
);

// 5. The same request twice is one expense. A guest on a slow phone browser is
//    exactly who taps Save twice.
const replayId = crypto.randomUUID();
const body = {
  groupId,
  description: 'Chai',
  expenseDate: new Date().toISOString().slice(0, 10),
  currency: 'INR',
  amount: '4000',
  splitParams: { kind: 'equal' },
  participants: [ghostId, hostMemberId],
  payers: { [ghostId]: '4000' },
  clientMutationId: replayId,
};
const first = await guest.functions.invoke('expense-write', { body });
const second = await guest.functions.invoke('expense-write', { body });
check(
  'saving twice writes one expense',
  second.data?.replayed === true && second.data?.expenseId === first.data?.expenseId,
  await describeError(second.error),
);

// 6. The browser and the app agree about the money. Both compute from the same
//    rows with the same @baaki/core code; if they could differ, there would be
//    no way to say which was lying.
const { data: expenses } = await guest
  .from('expenses')
  .select(
    `id, deleted_at,
     currentVersion:expense_versions!expenses_current_version_id_fkey (
       currency, amount, expense_date,
       payers:expense_payers ( member_id, amount ),
       shares:expense_shares ( member_id, amount )
     )`,
  )
  .eq('group_id', groupId);

const snapshots = (expenses ?? [])
  .filter((expense) => expense.currentVersion)
  .map((expense) => ({
    id: expense.id,
    currency: expense.currentVersion.currency,
    amount: BigInt(expense.currentVersion.amount),
    payers: Object.fromEntries(
      expense.currentVersion.payers.map((row) => [row.member_id, BigInt(row.amount)]),
    ),
    shares: Object.fromEntries(
      expense.currentVersion.shares.map((row) => [row.member_id, BigInt(row.amount)]),
    ),
    date: expense.currentVersion.expense_date,
    deletedAt: expense.deleted_at,
  }));

const computed = computeNetBalances(snapshots, []).get('INR') ?? new Map();
// Read as the guest, not as a service role: the derived table the server
// maintains has to be visible to a member, and it has to say the same thing.
const { data: serverBalances } = await guest
  .from('group_balances')
  .select('member_id, balance')
  .eq('group_id', groupId)
  .eq('currency', 'INR');

const agrees = (serverBalances ?? []).every(
  (row) => (computed.get(row.member_id) ?? 0n) === BigInt(row.balance),
);
check(
  "the browser's balances match the server's",
  agrees && (serverBalances ?? []).length > 0,
  JSON.stringify(
    (serverBalances ?? []).map((row) => [
      row.member_id.slice(0, 8),
      row.balance,
      String(computed.get(row.member_id)),
    ]),
  ),
);

const sum = [...computed.values()].reduce((total, value) => total + value, 0n);
check('balances sum to zero', sum === 0n, String(sum));

// 7. A different browser with the same anon key sees none of it. This is the
//    claim the whole design rests on: the key is public, RLS is the boundary.
const stranger = browser();
await stranger.auth.signInAnonymously();
const { data: strangerGroup } = await stranger.from('groups').select('id').eq('id', groupId);
const { data: strangerMembers } = await stranger
  .from('group_members')
  .select('id')
  .eq('group_id', groupId);
const { data: strangerExpenses } = await stranger
  .from('expenses')
  .select('id')
  .eq('group_id', groupId);
check(
  'another browser with the same key sees nothing',
  (strangerGroup ?? []).length === 0 &&
    (strangerMembers ?? []).length === 0 &&
    (strangerExpenses ?? []).length === 0,
  `${strangerGroup?.length}/${strangerMembers?.length}/${strangerExpenses?.length} rows`,
);

// 8. A stranger cannot write into the group either, token or no token.
const { error: strangerWrite } = await stranger.functions.invoke('expense-write', {
  body: {
    groupId,
    description: 'Not mine',
    expenseDate: new Date().toISOString().slice(0, 10),
    currency: 'INR',
    amount: '100',
    splitParams: { kind: 'equal' },
    participants: [ghostId],
    payers: { [ghostId]: '100' },
    clientMutationId: crypto.randomUUID(),
  },
});
check(
  'another browser cannot write into the group',
  Boolean(strangerWrite),
  await describeError(strangerWrite),
);

// 9. "…later installs, history intact." The half of that this can prove without
//    an app is that the ghost's place now belongs to the guest's own account —
//    the claimed member carries their profile id, so the expenses filed against
//    "Ravi" before they arrived are theirs from here on (ADR-006).
//
//    The other half — adding an email or a Google identity to the same
//    anonymous account rather than making a new one — is auth, which is not
//    built yet. It cannot be exercised here in any case: the project rate-limits
//    confirmation emails, so a test that sent one would fail on the second run
//    for a reason that has nothing to do with the code.
const {
  data: { user: stillTheSame },
} = await guest.auth.getUser();
check(
  'the guest is still the same account after all of it',
  stillTheSame?.id === guestUserId && stillTheSame?.is_anonymous === true,
  stillTheSame?.id,
);

const { data: claimedRow } = await guest
  .from('group_members')
  .select('id, profile_id, ghost_name')
  .eq('id', ghostId)
  .single();
check(
  "the ghost's place now belongs to the guest",
  claimedRow?.profile_id === guestUserId,
  `${claimedRow?.ghost_name} -> ${claimedRow?.profile_id?.slice(0, 8)}`,
);

const { data: afterClaim } = await guest.from('expenses').select('id').eq('group_id', groupId);
check(
  'the history filed against that name is still there',
  (afterClaim ?? []).length === (expenses ?? []).length,
  `${afterClaim?.length} of ${expenses?.length}`,
);

// ── clean up ────────────────────────────────────────────────────────────────

// Archived rather than deleted: the host is a normal member and a normal
// member cannot delete a ledger anybody else is in (ADR-004).
await host.from('groups').update({ archived_at: new Date().toISOString() }).eq('id', groupId);

console.log(`\n${pass.length}/${pass.length + fail.length} passed`);
if (fail.length > 0) {
  console.log('Failed:', fail.join(', '));
  process.exit(1);
}
