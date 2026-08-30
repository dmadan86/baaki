/**
 * The two ends of a pending settlement the payer and payee can reach by hand.
 *
 * A recorded UPI payment sits at `initiated` until the payee confirms it or the
 * seven-day clock does (m4-auto-confirm). Between those, two people can act:
 *
 *   * the PAYER can cancel a claim they should not have made — a duplicate, or a
 *     payment that never actually went through;
 *   * the PAYEE can dispute a claim — "that money never reached me".
 *
 * Both are party-scoped `SECURITY DEFINER` RPCs (baaki_cancel_settlement /
 * baaki_dispute_settlement), so the check for *who* may do it lives in the
 * database, not the client (ADR-013). This proves the who, the idempotency, and
 * that disputing an auto-confirmed settlement is allowed — the recovery path
 * ADR-007 promises when the clock confirmed something the payee denies.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, seedGroup } from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

interface Pending {
  groupId: string;
  settlementId: string;
  payerProfile: string;
  payeeProfile: string;
}

/** A recorded payment the payee has not answered yet. */
async function initiate(daysAgo = 0): Promise<Pending> {
  const { groupId, profileIds, memberIds } = await seedGroup(client, { memberCount: 2 });
  const settlementId = randomUUID();
  await client.query(
    `INSERT INTO settlements
       (id, group_id, from_member_id, to_member_id, currency, amount, method, status, initiated_at)
     VALUES ($1, $2, $3, $4, 'INR', 42000, 'upi', 'initiated', now() - ($5 || ' days')::interval)`,
    [settlementId, groupId, memberIds[0], memberIds[1], String(daysAgo)],
  );
  return {
    groupId,
    settlementId,
    payerProfile: profileIds[0] ?? '',
    payeeProfile: profileIds[1] ?? '',
  };
}

const statusOf = async (settlementId: string): Promise<string> => {
  const { rows } = await client.query(`SELECT status FROM settlements WHERE id = $1`, [
    settlementId,
  ]);
  return String(rows[0]?.status);
};

const setStatus = async (settlementId: string, status: string): Promise<void> => {
  await client.query(`UPDATE settlements SET status = $2 WHERE id = $1`, [settlementId, status]);
};

const activityOf = async (
  groupId: string,
): Promise<{ verb: string; payload: Record<string, unknown> | null }[]> => {
  const { rows } = await client.query(
    `SELECT verb, payload FROM activity_log
       WHERE group_id = $1 AND object_type = 'settlement' ORDER BY created_at`,
    [groupId],
  );
  return rows as { verb: string; payload: Record<string, unknown> | null }[];
};

/**
 * Call one of the transition RPCs as a specific person, exactly as the sync edge
 * does (`rpcAsCaller`): a signed-in `authenticated` role whose JWT `sub` is that
 * profile. The party check inside the definer function reads that `sub`.
 */
async function callAs<T = unknown>(
  profileId: string,
  sql: string,
  params: unknown[],
): Promise<T | { error: string }> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: profileId, role: 'authenticated' }),
  ]);
  await client.query(`SET ROLE authenticated`);
  try {
    const { rows } = await client.query(sql, params);
    return rows[0] as T;
  } catch (error) {
    return { error: (error as Error).message };
  } finally {
    await client.query(`RESET ROLE`);
    await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
  }
}

const cancel = (profileId: string, settlementId: string) =>
  callAs(profileId, `SELECT baaki_cancel_settlement($1)`, [settlementId]);

const dispute = (profileId: string, settlementId: string, reason: string | null = null) =>
  callAs(profileId, `SELECT baaki_dispute_settlement($1, $2)`, [settlementId, reason]);

describe('the payer cancels a claim they should not have made', () => {
  it('moves a pending settlement to cancelled', async () => {
    const { settlementId, payerProfile } = await initiate();
    await cancel(payerProfile, settlementId);
    expect(await statusOf(settlementId)).toBe('cancelled');
  });

  it('writes it to the activity log so the group can see it', async () => {
    const { groupId, settlementId, payerProfile } = await initiate();
    await cancel(payerProfile, settlementId);
    const log = await activityOf(groupId);
    expect(log.map((entry) => entry.verb)).toContain('cancelled');
  });

  it('refuses the payee — cancel is the payer tool, dispute is theirs', async () => {
    const { settlementId, payeeProfile } = await initiate();
    const result = await cancel(payeeProfile, settlementId);
    expect(result).toMatchObject({ error: expect.stringMatching(/NOT_THE_PAYER/) });
    expect(await statusOf(settlementId)).toBe('initiated');
  });

  it('refuses a stranger who is not in the group at all', async () => {
    const { settlementId } = await initiate();
    const result = await cancel(randomUUID(), settlementId);
    expect(result).toMatchObject({ error: expect.stringMatching(/NOT_THE_PAYER/) });
    expect(await statusOf(settlementId)).toBe('initiated');
  });

  it('is idempotent — a replayed offline cancel is a no-op, not a second log row', async () => {
    const { groupId, settlementId, payerProfile } = await initiate();
    await cancel(payerProfile, settlementId);
    const again = await cancel(payerProfile, settlementId);
    expect(again).not.toMatchObject({ error: expect.anything() });
    expect(await statusOf(settlementId)).toBe('cancelled');
    const cancels = (await activityOf(groupId)).filter((entry) => entry.verb === 'cancelled');
    expect(cancels).toHaveLength(1);
  });

  it('will not unwind a settlement somebody already confirmed', async () => {
    const { settlementId, payerProfile } = await initiate();
    await setStatus(settlementId, 'confirmed');
    const result = await cancel(payerProfile, settlementId);
    expect(result).toMatchObject({ error: expect.stringMatching(/NOT_CANCELLABLE/) });
    expect(await statusOf(settlementId)).toBe('confirmed');
  });
});

describe('the payee disputes a claim that never reached them', () => {
  it('moves a pending settlement to disputed', async () => {
    const { settlementId, payeeProfile } = await initiate();
    await dispute(payeeProfile, settlementId);
    expect(await statusOf(settlementId)).toBe('disputed');
  });

  it('reopens an auto-confirmed one — the clock confirmed what the payee denies', async () => {
    // The whole reason auto-confirm is acceptable: a week of silence can be
    // undone by the person it was assumed for. `auto_confirmed → disputed` is a
    // permitted transition precisely so the debt comes back until it is settled
    // for real.
    const { settlementId, payeeProfile } = await initiate();
    await setStatus(settlementId, 'auto_confirmed');
    const result = await dispute(payeeProfile, settlementId);
    expect(result).not.toMatchObject({ error: expect.anything() });
    expect(await statusOf(settlementId)).toBe('disputed');
  });

  it('records the reason when one is given', async () => {
    const { groupId, settlementId, payeeProfile } = await initiate();
    await dispute(payeeProfile, settlementId, 'never got it');
    const disputed = (await activityOf(groupId)).find((entry) => entry.verb === 'settle_disputed');
    expect(disputed?.payload?.reason).toBe('never got it');
  });

  it('refuses the payer — only the person who was paid can say it never arrived', async () => {
    const { settlementId, payerProfile } = await initiate();
    const result = await dispute(payerProfile, settlementId);
    expect(result).toMatchObject({ error: expect.stringMatching(/NOT_THE_PAYEE/) });
    expect(await statusOf(settlementId)).toBe('initiated');
  });

  it('is idempotent — a replayed dispute is a no-op, not a second log row', async () => {
    const { groupId, settlementId, payeeProfile } = await initiate();
    await dispute(payeeProfile, settlementId);
    const again = await dispute(payeeProfile, settlementId);
    expect(again).not.toMatchObject({ error: expect.anything() });
    expect(await statusOf(settlementId)).toBe('disputed');
    const disputes = (await activityOf(groupId)).filter(
      (entry) => entry.verb === 'settle_disputed',
    );
    expect(disputes).toHaveLength(1);
  });

  it('will not dispute a settlement somebody manually confirmed', async () => {
    const { settlementId, payeeProfile } = await initiate();
    await setStatus(settlementId, 'confirmed');
    const result = await dispute(payeeProfile, settlementId);
    expect(result).toMatchObject({ error: expect.stringMatching(/NOT_DISPUTABLE/) });
    expect(await statusOf(settlementId)).toBe('confirmed');
  });
});
