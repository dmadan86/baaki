/**
 * The guest ceilings, against live infrastructure (ADR-006 addendum, PR #146).
 *
 * The point of this test is server enforcement, not the app's own guard: every
 * call here is made straight to the RPC or the edge function, exactly as a
 * client that had patched out `useGuestGuard` would make it. If the ceiling only
 * lived in the mobile UI, all of these would pass when they must fail.
 *
 * What it proves:
 *   - a guest may create their first group, and only their first;
 *   - joining a group counts against the same one-group ceiling (the "any
 *     membership" rule), whether they created it or accepted an invite;
 *   - a brand-new guest's first join is never blocked;
 *   - being at the limit does not cost a guest their read access;
 *   - upgrading in place lifts the ceiling on the very same account, with the
 *     group they made as a guest still theirs.
 *
 * What it deliberately does NOT cover: the ten-day read-only expiry. That turns
 * on `auth.users.created_at`, which no client key can move, so it cannot be
 * reached end-to-end from here — it is unit-tested at the boundary in
 * packages/core/test/guestLimits.test.ts instead. The trial number is asserted
 * present below only as a guard against it silently drifting to zero.
 *
 * Self-cleanup: the run creates real rows on a live project, so it tidies after
 * itself in a `finally` — even when an assertion fails. A group carries an
 * append-only activity_log (ADR-004) that no client key may delete, so a full
 * purge needs a Supabase personal access token in SUPABASE_ACCESS_TOKEN: with
 * one, the groups, profiles and users this run made are removed outright via the
 * Management API (the only path that can lift the append-only guard). Without
 * one, the throwaway *accounts* are still deleted through the admin API so they
 * cannot accumulate run over run; only the inert append-only rows are left, with
 * a note saying how to purge them too.
 */
import { createClient } from '@supabase/supabase-js';

import { GUEST_GROUP_LIMIT, GUEST_TRIAL_DAYS } from '../supabase/functions/_shared/core.js';

const URL = process.env.SUPABASE_URL ?? 'https://xvjzbpgcmotoahtqcxve.supabase.co';
const ANON = process.env.ANON_KEY;
const SERVICE = process.env.SERVICE_KEY;

const pass = [];
const fail = [];
const check = (label, condition, detail = '') => {
  (condition ? pass : fail).push(label);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};
const skip = (label, why) => console.log(`SKIP  ${label} — ${why}`);

/** The code an edge function rejected with, dug out of its JSON body. */
async function edgeCode(error) {
  const context = error?.context;
  if (context && typeof context.json === 'function') {
    try {
      return (await context.json()).code ?? '';
    } catch {
      /* fall through */
    }
  }
  return error?.message ?? '';
}

const client = (key) =>
  createClient(URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
const service = createClient(URL, SERVICE, { auth: { persistSession: false } });

// Everything this run brings into being, so the finally below can take it back
// out. Groups are recorded the moment they are created; `named` records users.
const createdGroups = [];
const createdUsers = [];

const named = async (label) => {
  const c = client(ANON);
  await c.auth.signInAnonymously();
  const id = (await c.auth.getUser()).data.user.id;
  createdUsers.push(id);
  await c.from('profiles').update({ display_name: label }).eq('id', id);
  return { c, id };
};

const activeGroupCount = async (profileId) => {
  const { count } = await service
    .from('group_members')
    .select('id', { count: 'exact', head: true })
    .eq('profile_id', profileId)
    .is('left_at', null);
  return count ?? 0;
};

/**
 * Take back every row this run created.
 *
 * A group's activity_log is append-only (ADR-004): the trigger refuses the
 * cascade delete for anyone, service role included, and supabase-js cannot
 * disable it. So a real purge goes through the Management API with a personal
 * access token, which can drop the guard inside a transaction — the same steps,
 * in the same order, that a person would run by hand. Without a token, at least
 * delete the throwaway accounts so they do not pile up; the inert group and
 * activity rows are left, with a note on how to finish the job.
 */
async function cleanup() {
  const groups = [...new Set(createdGroups.filter(Boolean))];
  const users = [...new Set(createdUsers.filter(Boolean))];
  if (groups.length === 0 && users.length === 0) return;

  const pat = process.env.SUPABASE_ACCESS_TOKEN;
  if (pat) {
    // `URL` here is this file's project-URL string, not the global constructor
    // it shadows — so pull the project ref straight out of the host.
    const ref = URL.replace(/^https?:\/\//, '').split('.')[0];
    const list = (ids) => ids.map((id) => `'${id}'`).join(',');
    // Groups first (their members and invites cascade with them, and the
    // append-only activity_log with the guard lifted), then the now-unreferenced
    // profiles, then the auth users. All in one transaction, so a failure rolls
    // the guard back on by itself.
    const sql =
      'BEGIN; ALTER TABLE public.activity_log DISABLE TRIGGER USER;' +
      (groups.length ? ` DELETE FROM public.groups WHERE id IN (${list(groups)});` : '') +
      (users.length ? ` DELETE FROM public.profiles WHERE id IN (${list(users)});` : '') +
      (users.length ? ` DELETE FROM auth.users WHERE id IN (${list(users)});` : '') +
      ' ALTER TABLE public.activity_log ENABLE TRIGGER USER; COMMIT;';
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql }),
      });
      if (res.ok) {
        console.log(`CLEAN  purged ${groups.length} group(s) and ${users.length} user(s)`);
      } else {
        console.log(`WARN   cleanup failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      }
    } catch (error) {
      console.log(`WARN   cleanup could not reach the Management API: ${error.message}`);
    }
    return;
  }

  // No token: delete the accounts so they cannot accumulate, and say what is left.
  let removed = 0;
  for (const id of users) {
    const { error } = await service.auth.admin.deleteUser(id);
    if (!error) removed += 1;
  }
  console.log(
    `PARTIAL cleanup — removed ${removed}/${users.length} test account(s). ` +
      `${groups.length} group(s) plus their append-only activity_log remain (ADR-004); ` +
      `set SUPABASE_ACCESS_TOKEN to a Supabase PAT to purge those too.`,
  );
}

try {
  // The two numbers are what everything else here is checking against; if the
  // build ever ships them as 0 the rest of this file would pass vacuously.
  check('the group ceiling is one, not zero', GUEST_GROUP_LIMIT === 1, `${GUEST_GROUP_LIMIT}`);
  check('the trial is a positive number of days', GUEST_TRIAL_DAYS > 0, `${GUEST_TRIAL_DAYS}`);

  // ── a guest gets exactly one group of their own ───────────────────────────
  const asha = await named('Asha');

  const { data: first, error: firstError } = await asha.c.rpc('waves_create_group', {
    p_name: 'Goa trip',
    p_type: 'trip',
    p_currency: 'INR',
    p_emoji: '🏖️',
  });
  if (first) createdGroups.push(first);
  check('a guest can create their first group', !firstError && !!first, firstError?.message);

  const { data: second, error: secondError } = await asha.c.rpc('waves_create_group', {
    p_name: 'Second trip',
    p_type: 'trip',
    p_currency: 'INR',
  });
  if (second) createdGroups.push(second);
  check(
    'the RPC refuses a guest a second group',
    !second && /GUEST_GROUP_LIMIT/.test(secondError?.message ?? ''),
    secondError?.message,
  );
  check('and no phantom group was created', (await activeGroupCount(asha.id)) === 1);

  // ── joining counts against the same ceiling ───────────────────────────────
  // A separate organiser stands up a group nobody in this test belongs to yet,
  // and mints a link with room for every join attempt below.
  const organiser = await named('Bharat');
  const { data: hostGroup } = await organiser.c.rpc('waves_create_group', {
    p_name: 'Flatmates',
    p_type: 'home',
    p_currency: 'INR',
  });
  if (hostGroup) createdGroups.push(hostGroup);
  const { data: invite, error: mintError } = await organiser.c.functions.invoke('invite-mint', {
    body: { groupId: hostGroup, expiresInDays: 7 },
  });
  check(
    'the organiser can mint an invite',
    !mintError && !!invite?.token,
    await edgeCode(mintError),
  );

  // Asha already holds her one group, so accepting a second must be refused — by
  // the edge function, not by a screen she never loaded.
  const { error: ashaJoinError } = await asha.c.functions.invoke('invite-accept', {
    body: { token: invite.token, mode: 'join' },
  });
  check(
    'invite-accept refuses a guest already in a group',
    (await edgeCode(ashaJoinError)) === 'GUEST_GROUP_LIMIT',
    await edgeCode(ashaJoinError),
  );
  check('the refused join added no membership', (await activeGroupCount(asha.id)) === 1);

  // A brand-new guest with nothing yet joins their first group — the growth loop
  // must stay open, so this one is allowed.
  const chandra = await named('Chandra');
  const { data: chandraJoin, error: chandraJoinError } = await chandra.c.functions.invoke(
    'invite-accept',
    { body: { token: invite.token, mode: 'join' } },
  );
  check(
    "a fresh guest's first join is allowed",
    !chandraJoinError && !!chandraJoin?.memberId,
    await edgeCode(chandraJoinError),
  );

  // …and now that Chandra holds one group by joining, creating one of their own
  // is the second, which proves a joined group counts the same as a created one.
  const { data: chandraSecond, error: chandraSecondError } = await chandra.c.rpc(
    'waves_create_group',
    { p_name: 'My own', p_type: 'other', p_currency: 'INR' },
  );
  if (chandraSecond) createdGroups.push(chandraSecond);
  check(
    'a joined group fills the ceiling just as a created one does',
    !chandraSecond && /GUEST_GROUP_LIMIT/.test(chandraSecondError?.message ?? ''),
    chandraSecondError?.message,
  );

  // ── the ceiling caps writing, not reading ─────────────────────────────────
  // Asha is at her limit, but her one group and its ledger must stay fully hers.
  const { data: readBack, error: readError } = await asha.c
    .from('groups')
    .select('id, name')
    .eq('id', first);
  check(
    'a capped guest can still read the group they have',
    !readError && readBack?.[0]?.id === first,
    readError?.message,
  );

  // ── upgrading in place lifts the ceiling on the same account ──────────────
  // The whole reason the ceiling is safe: signing up does not start over.
  // Confirm an email onto Asha's anonymous account (what the app's updateUser
  // upgrade does under the hood), then the same account may create beyond the
  // guest limit — with the group she made as a guest still there.
  const upgradeEmail = `ceiling-${crypto.randomUUID()}@example.com`;
  const { error: upgradeError } = await service.auth.admin.updateUserById(asha.id, {
    email: upgradeEmail,
    email_confirm: true,
  });
  const stillAnonymous =
    (await service.auth.admin.getUserById(asha.id)).data.user?.is_anonymous === true;

  if (upgradeError || stillAnonymous) {
    skip(
      'upgrading lifts the ceiling',
      upgradeError ? await edgeCode(upgradeError) : 'account still anonymous after adding an email',
    );
  } else {
    const { data: postUpgrade, error: postUpgradeError } = await asha.c.rpc('waves_create_group', {
      p_name: 'Second, as a member',
      p_type: 'trip',
      p_currency: 'INR',
    });
    if (postUpgrade) createdGroups.push(postUpgrade);
    check(
      'a signed-up account is no longer capped',
      !postUpgradeError && !!postUpgrade,
      postUpgradeError?.message,
    );
    const { data: kept } = await service.from('groups').select('id').eq('id', first).single();
    check('the group made as a guest is still theirs after upgrading', kept?.id === first);
  }
} finally {
  await cleanup();
}

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) process.exit(1);
