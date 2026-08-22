/**
 * The personal expense-tag catalog (extends TDR §8).
 *
 * A tag is owned by one person and belongs to no group, so — like a capture —
 * the only thing between it and the next account is owner-keyed row-level
 * security, not group membership. These pin that boundary, the per-owner sync
 * sequence the offline pull depends on, the CHECK that a custom tag carries a
 * label, and the unique index that keeps a person's override of a built-in
 * single.
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

async function insertCustom(
  owner: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = (overrides.id as string) ?? randomUUID();
  await client.query(
    `INSERT INTO category_tags (id, owner_user_id, label, icon, tint, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      owner,
      (overrides.label as string) ?? 'Client dinner',
      (overrides.icon as string) ?? 'briefcase-outline',
      (overrides.tint as string) ?? 'mint',
      (overrides.sort_order as number) ?? 100,
    ],
  );
  return id;
}

describe('category_tags RLS — owner-only', () => {
  it('a tag is visible to its owner and to nobody else', async () => {
    const asha = await makeProfile('Asha');
    const ravi = await makeProfile('Ravi');

    const tagId = await asUser(asha, () => insertCustom(asha));

    const mine = await asUser(asha, () =>
      client.query(`SELECT id FROM category_tags WHERE id = $1`, [tagId]),
    );
    expect(mine.rows).toHaveLength(1);

    const theirs = await asUser(ravi, () =>
      client.query(`SELECT id FROM category_tags WHERE id = $1`, [tagId]),
    );
    expect(theirs.rows).toHaveLength(0);
  });

  it('refuses a tag written under another account', async () => {
    const asha = await makeProfile('Asha');
    const ravi = await makeProfile('Ravi');
    // Ravi, signed in as himself, cannot write a row owned by Asha.
    await asUser(ravi, () =>
      expectDenied(
        client.query(`INSERT INTO category_tags (id, owner_user_id, label) VALUES ($1, $2, $3)`, [
          randomUUID(),
          asha,
          'Sneaky',
        ]),
      ),
    );
  });
});

describe('category_tags — per-owner sync sequence', () => {
  it('stamps a monotonic updated_seq per owner on insert and update', async () => {
    const owner = await makeProfile('Seq');
    await asUser(owner, async () => {
      const a = await insertCustom(owner, { label: 'A' });
      await insertCustom(owner, { label: 'B' });
      await client.query(`UPDATE category_tags SET hidden = true WHERE id = $1`, [a]);

      const seqs = await client.query(
        `SELECT updated_seq FROM category_tags WHERE owner_user_id = $1 ORDER BY updated_seq`,
        [owner],
      );
      expect(seqs.rows).toHaveLength(2);
      // The updated row was stamped last, so its seq is the highest of the two.
      const values = seqs.rows.map((r) => Number(r.updated_seq));
      expect(values[0]).toBeGreaterThan(0);
      expect(values[1]).toBeGreaterThan(values[0]!);
    });
  });
});

describe('category_tags — structural guards', () => {
  it('rejects a custom tag with no label', async () => {
    const owner = await makeProfile('NoLabel');
    await asUser(owner, () =>
      expectDenied(
        client.query(
          `INSERT INTO category_tags (id, owner_user_id, sort_order) VALUES ($1, $2, $3)`,
          [randomUUID(), owner, 5],
        ),
      ),
    );
  });

  it('allows a built-in override to carry no label', async () => {
    const owner = await makeProfile('Override');
    await asUser(owner, async () => {
      await client.query(
        `INSERT INTO category_tags (id, owner_user_id, builtin_id, hidden, sort_order)
         VALUES ($1, $2, 'gifts', true, 3)`,
        [randomUUID(), owner],
      );
      const rows = await client.query(
        `SELECT builtin_id, hidden FROM category_tags WHERE owner_user_id = $1`,
        [owner],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ builtin_id: 'gifts', hidden: true });
    });
  });

  it('keeps a person override of a built-in single', async () => {
    const owner = await makeProfile('Dup');
    await asUser(owner, async () => {
      await client.query(
        `INSERT INTO category_tags (id, owner_user_id, builtin_id, sort_order)
         VALUES ($1, $2, 'food', 1)`,
        [randomUUID(), owner],
      );
      await expectDenied(
        client.query(
          `INSERT INTO category_tags (id, owner_user_id, builtin_id, sort_order)
           VALUES ($1, $2, 'food', 2)`,
          [randomUUID(), owner],
        ),
      );
    });
  });
});
