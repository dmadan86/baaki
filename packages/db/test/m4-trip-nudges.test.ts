/**
 * The two reminders a day that keep a trip ledger honest.
 *
 * The failure being prevented is not technical. Four people go to Goa; on day
 * one everybody adds everything; by day three nobody has entered anything since
 * the first lunch, and on the flight home somebody tries to reconstruct a week
 * of autorickshaws from memory. A shared ledger is only as good as the habit of
 * adding to it, and the habit has to be prompted while the trip is happening —
 * afterwards the receipts are gone and so is the will.
 *
 * Two things decide whether this feature is loved or muted, and both are tested
 * here rather than assumed:
 *
 *   * It asks in the *group's* timezone. A trip has a place, and breakfast
 *     means breakfast there. Waking somebody at 04:00 to ask about dinner
 *     somewhere else is worse than not asking.
 *   * It never asks about a day somebody already recorded. A reminder to do
 *     something already done is how people learn to ignore an app.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { addEqualSplitExpense, connect, seedGroup } from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

interface Trip {
  groupId: string;
  profileIds: string[];
  memberIds: string[];
}

async function seedTrip(
  options: {
    start?: string;
    end?: string;
    timeZone?: string;
    remind?: boolean;
    morning?: string;
    evening?: string;
  } = {},
): Promise<Trip> {
  const {
    start = '2026-03-10',
    end = '2026-03-14',
    timeZone = 'Asia/Kolkata',
    remind = true,
    morning = '09:00',
    evening = '21:00',
  } = options;

  const seeded = await seedGroup(client, { memberCount: 2, name: 'Goa' });
  await client.query(
    `UPDATE groups
        SET start_date = $2, end_date = $3, time_zone = $4,
            remind_daily = $5, remind_morning_at = $6, remind_evening_at = $7
      WHERE id = $1`,
    [seeded.groupId, start, end, timeZone, remind, morning, evening],
  );
  return seeded;
}

/** Run the job as if it were this instant. */
const runAt = async (instant: string): Promise<number> => {
  const { rows } = await client.query(`SELECT baaki_trip_nudges($1::timestamptz) AS n`, [instant]);
  return Number(rows[0]?.n);
};

interface NudgeRow {
  kind: string;
  payload: { date?: string; slot?: string };
}

/**
 * Scoped to one group as well as one person. The job sweeps every trip in the
 * database, and the other tests in this file have trips of their own.
 */
const nudgesFor = async (trip: Trip, memberIndex = 0): Promise<NudgeRow[]> => {
  const { rows } = await client.query(
    `SELECT kind, payload FROM notifications
      WHERE profile_id = $1 AND group_id = $2 AND kind LIKE 'trip_nudge%'
      ORDER BY kind`,
    [trip.profileIds[memberIndex], trip.groupId],
  );
  return rows as NudgeRow[];
};

const nudgeOfKind = async (
  trip: Trip,
  kind: 'trip_nudge_morning' | 'trip_nudge_evening',
  memberIndex = 0,
): Promise<NudgeRow | undefined> =>
  (await nudgesFor(trip, memberIndex)).find((row) => row.kind === kind);

/** An expense this member entered, dated on a particular day. */
async function addExpenseAuthoredBy(
  trip: Trip,
  memberIndex: number,
  expenseDate: string,
): Promise<void> {
  const author = trip.memberIds[memberIndex] ?? '';
  await addEqualSplitExpense(client, {
    groupId: trip.groupId,
    payers: { [author]: 20000n },
    // The helper credits the first participant as the author, and who entered
    // it is exactly what the nudge is looking at.
    participants: [author, ...trip.memberIds.filter((id) => id !== author)],
    amount: 20000n,
    description: 'Lunch',
    date: expenseDate,
  });
}

describe('during the trip', () => {
  it('asks at the end of the day about today', async () => {
    const trip = await seedTrip();
    // 21:30 in Kolkata on the second day.
    await runAt('2026-03-11T16:00:00Z');
    expect((await nudgeOfKind(trip, 'trip_nudge_evening'))?.payload?.date).toBe('2026-03-11');
  });

  it('asks at breakfast about yesterday', async () => {
    const trip = await seedTrip();
    // 09:30 in Kolkata — the meal at which you remember last night.
    await runAt('2026-03-11T04:00:00Z');
    const nudges = await nudgesFor(trip);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.kind).toBe('trip_nudge_morning');
    expect(nudges[0]?.payload?.date).toBe('2026-03-10');
  });

  it('asks everybody in the group, not only whoever created it', async () => {
    const trip = await seedTrip();
    await runAt('2026-03-11T04:00:00Z');
    expect(await nudgesFor(trip, 0)).toHaveLength(1);
    expect(await nudgesFor(trip, 1)).toHaveLength(1);
  });

  it('says nothing before the first slot of the day', async () => {
    const trip = await seedTrip();
    // 07:30 local: too early to have anything to say.
    await runAt('2026-03-11T02:00:00Z');
    expect(await nudgesFor(trip)).toHaveLength(0);
  });

  it('does not ask about a yesterday before the trip began', async () => {
    const trip = await seedTrip();
    // Breakfast on day one. There is no yesterday worth asking about.
    await runAt('2026-03-10T04:00:00Z');
    expect(await nudgesFor(trip)).toHaveLength(0);
  });

  it('still asks on the last day, which has the most unrecorded spending', async () => {
    const trip = await seedTrip();
    await runAt('2026-03-14T16:00:00Z');
    expect(await nudgeOfKind(trip, 'trip_nudge_evening')).toBeDefined();
  });
});

describe('outside the trip', () => {
  it('says nothing the day before it starts', async () => {
    const trip = await seedTrip();
    await runAt('2026-03-09T16:00:00Z');
    expect(await nudgesFor(trip)).toHaveLength(0);
  });

  it('says nothing the day after it ends', async () => {
    const trip = await seedTrip();
    await runAt('2026-03-15T16:00:00Z');
    expect(await nudgesFor(trip)).toHaveLength(0);
  });

  it('says nothing for a group that never gave dates', async () => {
    // Which is most groups: a flatshare has no start and no end.
    const seeded = await seedGroup(client, { memberCount: 2, name: 'Flat' });
    await runAt('2026-03-11T16:00:00Z');
    expect(await nudgesFor(seeded)).toHaveLength(0);
  });
});

describe('the timezone is the group’s, not the server’s', () => {
  it('waits for evening where the trip is', async () => {
    // 16:00 UTC is 21:30 in Kolkata but only 17:00 in London. A London trip is
    // still mid-afternoon: the end-of-day question has not come round there.
    const london = await seedTrip({ timeZone: 'Europe/London' });
    await runAt('2026-03-11T16:00:00Z');
    expect(await nudgeOfKind(london, 'trip_nudge_evening')).toBeUndefined();
  });

  it('and reaches them when evening actually arrives there', async () => {
    const london = await seedTrip({ timeZone: 'Europe/London' });
    await runAt('2026-03-11T21:30:00Z');
    expect(await nudgeOfKind(london, 'trip_nudge_evening')).toBeDefined();
  });
});

describe('not asking for something already done', () => {
  it('skips somebody who already added an expense for that day', async () => {
    const trip = await seedTrip();
    await addExpenseAuthoredBy(trip, 0, '2026-03-11');
    await runAt('2026-03-11T16:00:00Z');
    expect(await nudgeOfKind(trip, 'trip_nudge_evening')).toBeUndefined();
  });

  it('still asks the others, who have not', async () => {
    const trip = await seedTrip();
    await addExpenseAuthoredBy(trip, 0, '2026-03-11');
    await runAt('2026-03-11T16:00:00Z');
    expect(await nudgeOfKind(trip, 'trip_nudge_evening', 1)).toBeDefined();
  });

  it('judges by the day in question, not by having ever added anything', async () => {
    // An expense on Tuesday says nothing about whether Wednesday was recorded.
    const trip = await seedTrip();
    await addExpenseAuthoredBy(trip, 0, '2026-03-10');
    await runAt('2026-03-11T16:00:00Z');
    expect(await nudgeOfKind(trip, 'trip_nudge_evening')).toBeDefined();
  });
});

describe('respecting the answer somebody already gave', () => {
  it('says nothing to a group that turned reminders off', async () => {
    const trip = await seedTrip({ remind: false });
    await runAt('2026-03-11T16:00:00Z');
    expect(await nudgesFor(trip)).toHaveLength(0);
  });

  it('says nothing to a person who turned nudges off', async () => {
    const trip = await seedTrip();
    await client.query(
      `UPDATE profiles SET notification_prefs = '{"nudges": false}'::jsonb WHERE id = $1`,
      [trip.profileIds[0]],
    );
    await runAt('2026-03-11T16:00:00Z');
    expect(await nudgesFor(trip, 0)).toHaveLength(0);
    expect(await nudgesFor(trip, 1)).not.toHaveLength(0);
  });

  it('says nothing about an archived trip', async () => {
    const trip = await seedTrip();
    await client.query(`UPDATE groups SET archived_at = now() WHERE id = $1`, [trip.groupId]);
    await runAt('2026-03-11T16:00:00Z');
    expect(await nudgesFor(trip)).toHaveLength(0);
  });
});

describe('running more than once', () => {
  it('does not ask twice for the same day', async () => {
    const trip = await seedTrip();
    await runAt('2026-03-11T16:00:00Z');
    await runAt('2026-03-11T17:00:00Z');
    await runAt('2026-03-11T18:00:00Z');
    // One about yesterday, one about today, and nothing repeated however many
    // times the job runs.
    expect(await nudgesFor(trip)).toHaveLength(2);
  });

  it('sends a missed breakfast reminder late rather than never', async () => {
    // Cron was down all morning. By evening both slots have passed, and both
    // are still worth sending — the morning one is about a different day.
    const trip = await seedTrip();
    await runAt('2026-03-11T16:00:00Z');
    const kinds = (await nudgesFor(trip)).map((row) => row.kind);
    expect(kinds).toContain('trip_nudge_morning');
    expect(kinds).toContain('trip_nudge_evening');
  });

  it('asks again the next day, because it is a different day', async () => {
    const trip = await seedTrip();
    await runAt('2026-03-11T16:00:00Z');
    await runAt('2026-03-12T16:00:00Z');
    const dates = (await nudgesFor(trip)).map((row) => row.payload?.date);
    expect(new Set(dates).size).toBeGreaterThan(1);
  });
});

describe('who may run it', () => {
  it('is not something a signed-in person can trigger', async () => {
    const { profileIds } = await seedGroup(client, { memberCount: 1 });
    await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: profileIds[0], role: 'authenticated' }),
    ]);
    await client.query(`SET ROLE authenticated`);
    try {
      await expect(client.query(`SELECT baaki_trip_nudges()`)).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await client.query(`RESET ROLE`);
      await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
    }
  });
});
