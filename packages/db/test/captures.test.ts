/**
 * The personal inbox (TDR A34).
 *
 * A capture is an expense caught before it has a group. It is owned by one
 * person and belongs to no group, so the only thing standing between it and the
 * next account is row-level security keyed on the owner — not the group
 * membership that guards every other table. These pin that boundary, the
 * per-owner sync sequence the offline pull depends on, and the two CHECKs that
 * keep a malformed capture out of the table whoever queued it.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { connect, expectDenied } from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

async function makeProfile(name: string): Promise<string> {
  const id = randomUUID();
  await client.query(`INSERT INTO profiles (id, display_name) VALUES ($1, $2)`, [id, name]);
  return id;
}

async function asUser<T>(profileId: string, run: () => Promise<T>): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: profileId, role: 'authenticated' }),
  ]);
  await client.query(`SET ROLE authenticated`);
  try {
    return await run();
  } finally {
    await client.query(`RESET ROLE`);
    await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
  }
}

async function insertCapture(
  owner: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = (overrides.id as string) ?? randomUUID();
  await client.query(
    `INSERT INTO captures (id, owner_user_id, description, expense_date, currency, amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      owner,
      (overrides.description as string) ?? 'Petrol',
      (overrides.expense_date as string) ?? '2026-03-01',
      (overrides.currency as string) ?? 'INR',
      (overrides.amount as string) ?? '250000',
      (overrides.status as string) ?? 'open',
    ],
  );
  return id;
}

describe('captures RLS — owner-only', () => {
  it('a capture is visible to its owner and to nobody else', async () => {
    const asha = await makeProfile('Asha');
    const ravi = await makeProfile('Ravi');

    const captureId = await asUser(asha, () => insertCapture(asha));

    const mine = await asUser(asha, () =>
      client.query(`SELECT id FROM captures WHERE id = $1`, [captureId]),
    );
    expect(mine.rows).toHaveLength(1);

    const theirs = await asUser(ravi, () =>
      client.query(`SELECT id FROM captures WHERE id = $1`, [captureId]),
    );
    expect(theirs.rows).toHaveLength(0);
  });

  it('refuses a capture inserted under someone else as owner', async () => {
    const asha = await makeProfile('Asha');
    const ravi = await makeProfile('Ravi');

    const message = await asUser(asha, () =>
      expectDenied(insertCapture(ravi, { id: randomUUID() })),
    );
    expect(message).toMatch(/row-level security|violates/i);
  });

  it('lets nobody update a capture that is not theirs', async () => {
    const asha = await makeProfile('Asha');
    const ravi = await makeProfile('Ravi');
    const captureId = await asUser(asha, () => insertCapture(asha));

    // RLS scopes the row out of Ravi's reach, so his UPDATE matches nothing.
    const updated = await asUser(ravi, () =>
      client.query(`UPDATE captures SET description = 'hijacked' WHERE id = $1`, [captureId]),
    );
    expect(updated.rowCount).toBe(0);

    const still = await asUser(asha, () =>
      client.query(`SELECT description FROM captures WHERE id = $1`, [captureId]),
    );
    expect(still.rows[0].description).toBe('Petrol');
  });
});

describe('captures — per-owner sync sequence', () => {
  it('stamps a monotonic updated_seq per owner on insert and update', async () => {
    const asha = await makeProfile('Asha');

    await asUser(asha, async () => {
      const first = await insertCapture(asha);
      const second = await insertCapture(asha);

      const seqs = await client.query(
        `SELECT id, updated_seq FROM captures WHERE owner_user_id = $1 ORDER BY updated_seq`,
        [asha],
      );
      expect(seqs.rows).toHaveLength(2);
      const [a, b] = seqs.rows;
      expect(Number(a.updated_seq)).toBeGreaterThan(0);
      expect(Number(b.updated_seq)).toBeGreaterThan(Number(a.updated_seq));

      // An update moves the row's seq forward again, so a second device pulls it.
      const before = Number(b.updated_seq);
      await client.query(`UPDATE captures SET description = 'edited' WHERE id = $1`, [second]);
      const after = await client.query(`SELECT updated_seq FROM captures WHERE id = $1`, [second]);
      expect(Number(after.rows[0].updated_seq)).toBeGreaterThan(before);
      expect(first).not.toBe(second);
    });
  });

  it('counts each owner sequence independently', async () => {
    const asha = await makeProfile('Asha');
    const ravi = await makeProfile('Ravi');

    await asUser(asha, () => insertCapture(asha));
    await asUser(asha, () => insertCapture(asha));
    const raviSeq = await asUser(ravi, async () => {
      await insertCapture(ravi);
      const { rows } = await client.query(
        `SELECT updated_seq FROM captures WHERE owner_user_id = $1`,
        [ravi],
      );
      return Number(rows[0].updated_seq);
    });
    // Ravi's first capture is his seq 1, regardless of how many Asha made.
    expect(raviSeq).toBe(1);
  });
});

describe('captures — a malformed capture never lands', () => {
  it('refuses a negative amount', async () => {
    const asha = await makeProfile('Asha');
    const message = await asUser(asha, () => expectDenied(insertCapture(asha, { amount: '-1' })));
    expect(message).toMatch(/captures_amount_nonneg|violates check/i);
  });

  it('refuses an unknown status', async () => {
    const asha = await makeProfile('Asha');
    const message = await asUser(asha, () =>
      expectDenied(insertCapture(asha, { status: 'archived' })),
    );
    expect(message).toMatch(/captures_status_check|violates check/i);
  });
});
