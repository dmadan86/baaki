/**
 * The end of the settlement state machine.
 *
 * A payer opens their UPI app, pays, comes back and says so. The settlement
 * sits at `initiated` waiting for the payee to confirm — and from the payee's
 * side nothing is owed any more, so there is no reason for them to open the app
 * again. Left alone, that settlement never resolves and the group's balances
 * are quietly wrong for everybody, forever.
 *
 * ADR-007 closes it with time rather than cryptography: seven days of silence
 * counts as agreement, both people are told, and a dispute still reopens it.
 * That last part is what makes the first part acceptable, so it is tested here
 * rather than assumed.
 *
 * The clock is an argument to the function. A job whose time cannot be moved
 * can only be tested by waiting a week, which means it would not be tested.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { big, connect, seedGroup } from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

interface Settled {
  groupId: string;
  settlementId: string;
  payerProfile: string;
  payeeProfile: string;
}

/** A payment somebody says they made, waiting to be confirmed. */
async function initiateSettlement(daysAgo: number, ghostPayee = false): Promise<Settled> {
  const { groupId, profileIds, memberIds } = await seedGroup(client, {
    memberCount: ghostPayee ? 1 : 2,
    ghostCount: ghostPayee ? 1 : 0,
  });
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

const inboxOf = async (profileId: string): Promise<{ kind: string; body: string }[]> => {
  const { rows } = await client.query(
    `SELECT kind, body FROM notifications WHERE profile_id = $1 ORDER BY created_at`,
    [profileId],
  );
  return rows as { kind: string; body: string }[];
};

const run = async (): Promise<number> => {
  const { rows } = await client.query(`SELECT waves_auto_confirm_settlements() AS n`);
  return Number(rows[0]?.n);
};

describe('seven days of silence', () => {
  it('resolves a settlement nobody answered', async () => {
    const { settlementId } = await initiateSettlement(8);
    await run();
    expect(await statusOf(settlementId)).toBe('auto_confirmed');
  });

  it('leaves one that is only six days old', async () => {
    // The promise is seven days. Six is still somebody's chance to dispute.
    const { settlementId } = await initiateSettlement(6);
    await run();
    expect(await statusOf(settlementId)).toBe('initiated');
  });

  it('stamps confirmed_at, so the ledger says when it happened', async () => {
    const { settlementId } = await initiateSettlement(8);
    await run();
    const { rows } = await client.query(`SELECT confirmed_at FROM settlements WHERE id = $1`, [
      settlementId,
    ]);
    expect(rows[0]?.confirmed_at).not.toBeNull();
  });

  it('counts towards the balances, exactly as a confirmed one does', async () => {
    const { groupId, settlementId } = await initiateSettlement(8);
    const before = await client.query(
      `SELECT COALESCE(SUM(ABS(balance)), 0) AS total FROM group_balances WHERE group_id = $1`,
      [groupId],
    );
    await run();
    const after = await client.query(
      `SELECT COALESCE(SUM(ABS(balance)), 0) AS total FROM group_balances WHERE group_id = $1`,
      [groupId],
    );
    // An auto-confirmed settlement that did not move the numbers would be a
    // status change and nothing more.
    expect(big(after.rows[0]?.total)).not.toBe(big(before.rows[0]?.total));
    expect(await statusOf(settlementId)).toBe('auto_confirmed');
  });
});

describe('what it never touches', () => {
  it('leaves a settlement that was already disputed', async () => {
    const { settlementId } = await initiateSettlement(30);
    await client.query(`UPDATE settlements SET status = 'disputed' WHERE id = $1`, [settlementId]);
    await run();
    expect(await statusOf(settlementId)).toBe('disputed');
  });

  it('leaves a cancelled one alone however old it is', async () => {
    const { settlementId } = await initiateSettlement(400);
    await client.query(`UPDATE settlements SET status = 'cancelled' WHERE id = $1`, [settlementId]);
    await run();
    expect(await statusOf(settlementId)).toBe('cancelled');
  });

  it('does not undo a confirmation somebody actually gave', async () => {
    const { settlementId } = await initiateSettlement(9);
    await client.query(`UPDATE settlements SET status = 'confirmed' WHERE id = $1`, [settlementId]);
    await run();
    expect(await statusOf(settlementId)).toBe('confirmed');
  });
});

describe('a dispute still reopens it', () => {
  it('because the confirmation was assumed, not given', async () => {
    // This is the whole reason auto-confirming is defensible. Without it, a
    // week of not opening the app would be an irreversible admission.
    const { settlementId } = await initiateSettlement(10);
    await run();
    await client.query(`UPDATE settlements SET status = 'disputed' WHERE id = $1`, [settlementId]);
    expect(await statusOf(settlementId)).toBe('disputed');
  });
});

describe('both people are told', () => {
  it('reaches the payee, who is the one who might dispute it', async () => {
    const { payeeProfile } = await initiateSettlement(8);
    await run();
    const inbox = await inboxOf(payeeProfile);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.kind).toBe('settlement_confirmed');
  });

  it('reaches the payer, whose payment stopped being provisional', async () => {
    const { payerProfile } = await initiateSettlement(8);
    await run();
    expect(await inboxOf(payerProfile)).toHaveLength(1);
  });

  it('says which side of it the reader was on', async () => {
    const { payerProfile, payeeProfile } = await initiateSettlement(8);
    await run();
    const [payer] = await inboxOf(payerProfile);
    const [payee] = await inboxOf(payeeProfile);
    // Two people, one event, and the same sentence would be wrong for one of
    // them.
    expect(payer?.body).not.toBe(payee?.body);
  });

  it('skips a ghost, who has no account to be told on', async () => {
    const { payerProfile } = await initiateSettlement(8, true);
    const written = await run();
    expect(written).toBe(1);
    expect(await inboxOf(payerProfile)).toHaveLength(1);
  });

  it('writes it to the activity log as well, so the group can see it', async () => {
    const { groupId } = await initiateSettlement(8);
    await run();
    const { rows } = await client.query(
      `SELECT verb, payload FROM activity_log WHERE group_id = $1 AND object_type = 'settlement'`,
      [groupId],
    );
    expect(rows[0]?.verb).toBe('auto_confirmed');
    expect(rows[0]?.payload?.reason).toBe('no_response_in_window');
  });
});

describe('running the job twice', () => {
  it('sends nothing a second time', async () => {
    // A scheduled job runs twice sooner or later — a retry after a timeout, an
    // overlapping run, a manual invocation. Two identical notifications about
    // the same settlement is how people learn to ignore the app.
    const { payeeProfile } = await initiateSettlement(8);
    await run();
    await run();
    expect(await inboxOf(payeeProfile)).toHaveLength(1);
  });

  it('reports nothing left to do', async () => {
    await initiateSettlement(8);
    await run();
    const second = await run();
    expect(second).toBe(0);
  });
});

describe('who may run it', () => {
  it('is not something a signed-in person can trigger', async () => {
    // Otherwise anybody with an account could confirm every pending settlement
    // in the database, including ones they are not party to.
    const { profileIds } = await seedGroup(client, { memberCount: 1 });
    await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: profileIds[0], role: 'authenticated' }),
    ]);
    await client.query(`SET ROLE authenticated`);
    try {
      await expect(client.query(`SELECT waves_auto_confirm_settlements()`)).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await client.query(`RESET ROLE`);
      await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
    }
  });
});
