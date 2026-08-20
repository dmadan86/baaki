/**
 * Auto-archiving long-untouched groups (the privacy note's retention promise).
 *
 * The privacy screen tells people a group left closed and untouched for a year
 * and a half moves to their archive automatically, nothing deleted. This is the
 * job behind that sentence, so the sentence is tested rather than assumed.
 *
 * "Untouched" is the newest of the group's creation and its last expense,
 * settlement, or activity-log entry — never `updated_at`, which the raw SQL of
 * the sync cursor does not stamp. The clock is an argument to the function, and
 * the fixtures backdate `created_at` instead of waiting eighteen months, so the
 * boundary can actually be exercised.
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

/** Push a group's creation — and any activity it carries — into the past. */
async function ageGroup(groupId: string, ageText: string): Promise<void> {
  await client.query(`UPDATE groups SET created_at = now() - $2::interval WHERE id = $1`, [
    groupId,
    ageText,
  ]);
  await client.query(
    `UPDATE activity_log SET created_at = now() - $2::interval WHERE group_id = $1`,
    [groupId, ageText],
  );
}

const archivedAtOf = async (groupId: string): Promise<Date | null> => {
  const { rows } = await client.query(`SELECT archived_at FROM groups WHERE id = $1`, [groupId]);
  return rows[0]?.archived_at ?? null;
};

const runJob = async (): Promise<number> => {
  const { rows } = await client.query(`SELECT public.baaki_auto_archive_stale_groups() AS n`);
  return Number(rows[0]?.n ?? 0);
};

describe('baaki_auto_archive_stale_groups', () => {
  it('archives a group that has sat untouched past the window', async () => {
    const { groupId } = await seedGroup(client, { memberCount: 2 });
    await ageGroup(groupId, '2 years');

    await runJob();

    expect(await archivedAtOf(groupId)).not.toBeNull();
  });

  it('leaves a group alone while it still has recent activity', async () => {
    const { groupId, memberIds } = await seedGroup(client, { memberCount: 2 });
    // Old group, but a bill was added just now — that is a touch inside the
    // window, so it must not be archived.
    await ageGroup(groupId, '2 years');
    await addEqualSplitExpense(client, {
      groupId,
      payers: { [memberIds[0] ?? '']: 42000n },
      participants: [memberIds[0] ?? '', memberIds[1] ?? ''],
      amount: 42000n,
    });

    await runJob();

    expect(await archivedAtOf(groupId)).toBeNull();
  });

  it('leaves a freshly created group alone', async () => {
    const { groupId } = await seedGroup(client, { memberCount: 2 });

    await runJob();

    expect(await archivedAtOf(groupId)).toBeNull();
  });

  it('does not re-touch an already-archived group and is idempotent', async () => {
    const { groupId } = await seedGroup(client, { memberCount: 2 });
    await ageGroup(groupId, '2 years');

    await runJob();
    const firstArchivedAt = await archivedAtOf(groupId);
    expect(firstArchivedAt).not.toBeNull();

    // A second sweep must not find it again, nor move its archive time.
    await runJob();
    const secondArchivedAt = await archivedAtOf(groupId);
    expect(secondArchivedAt?.getTime()).toBe(firstArchivedAt?.getTime());
  });

  it('writes an auto_archived line to the group feed', async () => {
    const { groupId } = await seedGroup(client, { memberCount: 2 });
    await ageGroup(groupId, '2 years');

    await runJob();

    const { rows } = await client.query(
      `SELECT verb, object_type FROM activity_log
        WHERE group_id = $1 AND verb = 'auto_archived'`,
      [groupId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.object_type).toBe('group');
  });
});
