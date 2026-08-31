/**
 * Private / party-only attachments — the RLS threat model from
 * docs/private-attachments-security-review.md §5. Every one of these must be
 * green before the feature ships: a leak here is a real-world harm (a payment
 * screenshot or a personal bill reaching someone it must not).
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import {
  addEqualSplitExpense,
  connect,
  expectDenied,
  seedCommittedObject,
  seedGroup,
} from './helpers';

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

/** Run as a profile and commit — reads across role switches need the seed rows. */
async function as<T>(profileId: string | null, run: () => Promise<T>): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    profileId
      ? JSON.stringify({ sub: profileId, role: 'authenticated' })
      : JSON.stringify({ role: 'anon' }),
  ]);
  await client.query(`SET ROLE ${profileId ? 'authenticated' : 'anon'}`);
  try {
    return await run();
  } finally {
    await client.query('RESET ROLE');
  }
}

async function makeSettlement(groupId: string, from: string, to: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, currency, amount, method, status)
     VALUES ($1, $2, $3, $4, 'INR', 1000, 'upi', 'initiated')`,
    [id, groupId, from, to],
  );
  return id;
}

const countProofs = (settlementId: string) =>
  client
    .query(`SELECT count(*)::int AS n FROM settlement_proofs WHERE settlement_id = $1`, [
      settlementId,
    ])
    .then((r) => r.rows[0].n as number);

const countAttachments = (expenseId: string) =>
  client
    .query(`SELECT count(*)::int AS n FROM expense_attachments WHERE expense_id = $1`, [expenseId])
    .then((r) => r.rows[0].n as number);

// A shared fixture: a group of three, a settlement m0→m1 (parties m0,m1), and an
// expense paid by m0 (parties {m0}). m2 is a member but party to neither.
let g: { groupId: string; profileIds: string[]; memberIds: string[] };
let settlementId: string;
let expenseId: string;

beforeAll(async () => {
  g = await seedGroup(client, { memberCount: 3, name: 'Parties' });
  settlementId = await makeSettlement(
    g.groupId,
    g.memberIds[0] as string,
    g.memberIds[1] as string,
  );
  ({ expenseId } = await addEqualSplitExpense(client, {
    groupId: g.groupId,
    payers: { [g.memberIds[0] as string]: 3000n },
    participants: g.memberIds,
    amount: 3000n,
  }));
});

beforeEach(async () => {
  await client.query(`DELETE FROM settlement_proofs WHERE group_id = $1`, [g.groupId]);
  await client.query(`DELETE FROM expense_attachments WHERE group_id = $1`, [g.groupId]);
});

// The attach RPCs now require a committed `storage_objects` row at the key (the
// real client uploads via r2-sign's put + commit first). Seed that row before
// each attach; a call meant to fail earlier (non-party, bad path) simply never
// reaches the committed-object check, so seeding is harmless there.
const attachProof = async (sid: string, path: string, id: string | null = null) => {
  await seedCommittedObject(client, {
    bucket: 'settlement-proofs',
    path,
    ownerProfileId: g.profileIds[0] as string,
  });
  return client.query(`SELECT baaki_attach_settlement_proof($1, $2, $3) AS id`, [sid, path, id]);
};

const attachExpense = async (
  eid: string,
  path: string,
  visibility: string,
  id: string | null = null,
) => {
  await seedCommittedObject(client, {
    bucket: 'expense-attachments',
    path,
    ownerProfileId: g.profileIds[0] as string,
  });
  return client.query(`SELECT baaki_attach_expense_attachment($1, $2, $3, $4) AS id`, [
    eid,
    path,
    visibility,
    id,
  ]);
};

describe('T13 — party predicates', () => {
  it('answer true for a party and false for a non-party', async () => {
    const settlementParty = (pid: string) =>
      as(pid, () =>
        client
          .query(`SELECT baaki_is_settlement_party($1) AS x`, [settlementId])
          .then((r) => r.rows[0].x as boolean),
      );
    expect(await settlementParty(g.profileIds[0] as string)).toBe(true);
    expect(await settlementParty(g.profileIds[1] as string)).toBe(true);
    expect(await settlementParty(g.profileIds[2] as string)).toBe(false);

    const expenseParty = (pid: string) =>
      as(pid, () =>
        client
          .query(`SELECT baaki_is_expense_party($1) AS x`, [expenseId])
          .then((r) => r.rows[0].x as boolean),
      );
    expect(await expenseParty(g.profileIds[0] as string)).toBe(true);
    expect(await expenseParty(g.profileIds[1] as string)).toBe(false);
    expect(await expenseParty(g.profileIds[2] as string)).toBe(false);
  });
});

describe('settlement proofs', () => {
  it('T2 — both parties see the proof, T1 — a non-party sees zero rows', async () => {
    await as(g.profileIds[0] as string, () =>
      attachProof(settlementId, `${settlementId}/${randomUUID()}.webp`),
    );
    const seen = (pid: string) => as(pid, () => countProofs(settlementId));
    expect(await seen(g.profileIds[0] as string)).toBe(1); // payer
    expect(await seen(g.profileIds[1] as string)).toBe(1); // payee
    expect(await seen(g.profileIds[2] as string)).toBe(0); // T1: non-party
  });

  it('T8 — a non-party cannot attach', async () => {
    await as(g.profileIds[2] as string, async () => {
      const message = await expectDenied(attachProof(settlementId, `${settlementId}/x.webp`));
      expect(message).toMatch(/NOT_A_PARTY/);
    });
  });

  it('T15 — a key not scoped to the subject is refused', async () => {
    await as(g.profileIds[0] as string, async () => {
      const message = await expectDenied(attachProof(settlementId, `not-the-subject/x.webp`));
      expect(message).toMatch(/INVALID_PATH/);
    });
  });

  it('T16 — a non-party replaying an existing id is denied, not handed the row', async () => {
    // The replay short-circuit must not run before the party check, or a
    // non-party who supplies a real id gets a success — an existence oracle.
    const proofId = await as(g.profileIds[0] as string, () =>
      attachProof(settlementId, `${settlementId}/${randomUUID()}.webp`).then((r) =>
        String(r.rows[0].id),
      ),
    );
    await as(g.profileIds[2] as string, async () => {
      const message = await expectDenied(
        attachProof(settlementId, `${settlementId}/${randomUUID()}.webp`, proofId),
      );
      expect(message).toMatch(/NOT_A_PARTY/);
    });
  });

  it('T9/T11-write — the table is not writable directly (uploader cannot be forged)', async () => {
    await as(g.profileIds[0] as string, async () => {
      const message = await expectDenied(
        client.query(
          `INSERT INTO settlement_proofs (settlement_id, group_id, uploader_member_id, storage_path)
           VALUES ($1, $2, $3, 'x')`,
          [settlementId, g.groupId, g.memberIds[1]],
        ),
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('T14 — remove then re-attach rotates the key; a second live proof is refused', async () => {
    const firstPath = `${settlementId}/${randomUUID()}.webp`;
    const proofId = await as(g.profileIds[0] as string, () =>
      attachProof(settlementId, firstPath).then((r) => String(r.rows[0].id)),
    );
    // A second live proof without removing the first is refused.
    await as(g.profileIds[0] as string, async () => {
      const message = await expectDenied(
        attachProof(settlementId, `${settlementId}/${randomUUID()}.webp`),
      );
      expect(message).toMatch(/PROOF_EXISTS/);
    });
    // Remove, then re-attach with a fresh key → different storage_path.
    await as(g.profileIds[1] as string, () =>
      client.query(`SELECT baaki_remove_settlement_proof($1)`, [proofId]),
    );
    const secondPath = `${settlementId}/${randomUUID()}.webp`;
    await as(g.profileIds[0] as string, () => attachProof(settlementId, secondPath));
    const { rows } = await client.query(
      `SELECT storage_path FROM settlement_proofs
        WHERE settlement_id = $1 AND deleted_at IS NULL`,
      [settlementId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].storage_path).toBe(secondPath);
    expect(secondPath).not.toBe(firstPath);
  });
});

describe('expense attachments', () => {
  it('T3 — a group-visible attachment is seen by every member', async () => {
    await as(g.profileIds[0] as string, () =>
      attachExpense(expenseId, `${expenseId}/${randomUUID()}.webp`, 'group'),
    );
    for (const pid of g.profileIds) {
      expect(await as(pid, () => countAttachments(expenseId))).toBe(1);
    }
  });

  it('T4 — a parties-visible attachment is seen only by a party', async () => {
    await as(g.profileIds[0] as string, () =>
      attachExpense(expenseId, `${expenseId}/${randomUUID()}.webp`, 'parties'),
    );
    expect(await as(g.profileIds[0] as string, () => countAttachments(expenseId))).toBe(1); // party
    expect(await as(g.profileIds[1] as string, () => countAttachments(expenseId))).toBe(0); // member, not party
    expect(await as(g.profileIds[2] as string, () => countAttachments(expenseId))).toBe(0);
  });

  it('T8 — a non-party cannot attach', async () => {
    await as(g.profileIds[1] as string, async () => {
      const message = await expectDenied(
        attachExpense(expenseId, `${expenseId}/x.webp`, 'parties'),
      );
      expect(message).toMatch(/NOT_A_PARTY/);
    });
  });
});

describe('T17 — the per-expense gallery cap (A46)', () => {
  const addOne = (eid: string) => attachExpense(eid, `${eid}/${randomUUID()}.webp`, 'group');

  it('a free group is capped at two gallery attachments per expense', async () => {
    // `g` is an unpaid group; `expenseId` is paid by m0, so m0 is the party.
    // beforeEach cleared any attachment, so the count starts at zero.
    await as(g.profileIds[0] as string, () => addOne(expenseId));
    await as(g.profileIds[0] as string, () => addOne(expenseId));
    expect(await countAttachments(expenseId)).toBe(2);

    const message = await as(g.profileIds[0] as string, () => expectDenied(addOne(expenseId)));
    expect(message).toMatch(/ATTACHMENT_CAP/);
    expect(await countAttachments(expenseId)).toBe(2);
  });

  it('removing one frees a slot', async () => {
    await as(g.profileIds[0] as string, () => addOne(expenseId));
    const { rows } = await as(g.profileIds[0] as string, () => addOne(expenseId));
    const secondId = rows[0].id as string;
    // At the cap; a third is refused.
    expect(await as(g.profileIds[0] as string, () => expectDenied(addOne(expenseId)))).toMatch(
      /ATTACHMENT_CAP/,
    );
    // Remove one → a live count of 1 → the next add is allowed again.
    await as(g.profileIds[0] as string, () =>
      client.query(`SELECT baaki_remove_expense_attachment($1)`, [secondId]),
    );
    await as(g.profileIds[0] as string, () => addOne(expenseId));
    // Two live (the first and the re-add); the soft-deleted one is not counted.
    const live = await client
      .query(
        `SELECT count(*)::int AS n FROM expense_attachments
          WHERE expense_id = $1 AND deleted_at IS NULL`,
        [expenseId],
      )
      .then((r) => r.rows[0].n as number);
    expect(live).toBe(2);
  });

  it('a paid group has no attachment cap', async () => {
    const grp = await seedGroup(client, { memberCount: 1, name: 'PaidGallery' });
    const { expenseId: eid } = await addEqualSplitExpense(client, {
      groupId: grp.groupId,
      payers: { [grp.memberIds[0] as string]: 1000n },
      participants: grp.memberIds,
      amount: 1000n,
    });
    // One member holds an active subscription → the whole group is paid, so the
    // cap does not apply (baaki_group_is_paid).
    await client.query(
      `INSERT INTO subscriptions (profile_id, tier, period, status, current_period_end, store)
       VALUES ($1, 'plus', 'monthly', 'active', now() + interval '30 days', 'play')`,
      [grp.profileIds[0]],
    );

    for (let i = 0; i < 4; i += 1) {
      await as(grp.profileIds[0] as string, () => addOne(eid));
    }
    expect(await countAttachments(eid)).toBe(4);
  });
});

describe('the outer gates', () => {
  it('T6 — anon sees no restricted rows', async () => {
    await as(g.profileIds[0] as string, () =>
      attachProof(settlementId, `${settlementId}/${randomUUID()}.webp`),
    );
    // Refused at the grant, not filtered to zero: since
    // 20260831120000_anon_surface_hardening the signed-out role holds no
    // privilege on `settlement_proofs` at all.
    await expectDenied(as(null, () => countProofs(settlementId)));
  });

  it('T7 — an outsider from another group sees nothing', async () => {
    await as(g.profileIds[0] as string, () =>
      attachProof(settlementId, `${settlementId}/${randomUUID()}.webp`),
    );
    const other = await seedGroup(client, { memberCount: 1, name: 'Elsewhere' });
    expect(await as(other.profileIds[0] as string, () => countProofs(settlementId))).toBe(0);
  });

  it('T5 — a former party who left the group loses the row', async () => {
    const grp = await seedGroup(client, { memberCount: 2, name: 'Leaver' });
    const sid = await makeSettlement(
      grp.groupId,
      grp.memberIds[0] as string,
      grp.memberIds[1] as string,
    );
    await as(grp.profileIds[0] as string, () => attachProof(sid, `${sid}/${randomUUID()}.webp`));
    expect(await as(grp.profileIds[0] as string, () => countProofs(sid))).toBe(1);
    // The payer leaves — is_group_member is now false, the first conjunct denies.
    await client.query(`UPDATE group_members SET left_at = now() WHERE id = $1`, [
      grp.memberIds[0],
    ]);
    expect(await as(grp.profileIds[0] as string, () => countProofs(sid))).toBe(0);
  });

  it('T10 — dropping a member from the payers removes their access, live', async () => {
    const grp = await seedGroup(client, { memberCount: 3, name: 'Repoint' });
    // Both m0 and m1 pay → parties {m0, m1}.
    const { expenseId: eid, versionId } = await addEqualSplitExpense(client, {
      groupId: grp.groupId,
      payers: { [grp.memberIds[0] as string]: 1500n, [grp.memberIds[1] as string]: 1500n },
      participants: grp.memberIds,
      amount: 3000n,
    });
    await as(grp.profileIds[0] as string, () =>
      attachExpense(eid, `${eid}/${randomUUID()}.webp`, 'parties'),
    );
    expect(await as(grp.profileIds[1] as string, () => countAttachments(eid))).toBe(1);

    // A new current version paid by m0 only, authored by m0 → m1 is no longer a
    // party. Wrapped in a transaction so the payer-sum check (a deferred
    // constraint) sees the payer row before it fires at commit.
    const v2 = randomUUID();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO expense_versions
         (id, expense_id, version_no, author_member_id, description, category, expense_date,
          currency, amount, split_type, split_params)
       VALUES ($1, $2, 2, $3, 'v2', NULL, '2026-03-02', 'INR', 3000, 'equal', '{"kind":"equal"}'::jsonb)`,
      [v2, eid, grp.memberIds[0]],
    );
    await client.query(
      `INSERT INTO expense_payers (id, expense_version_id, member_id, amount) VALUES ($1, $2, $3, 3000)`,
      [randomUUID(), v2, grp.memberIds[0]],
    );
    // Shares must still sum to the amount (SHARE_MISMATCH guard) — 1000 each.
    for (const memberId of grp.memberIds) {
      await client.query(
        `INSERT INTO expense_shares (id, expense_version_id, member_id, amount) VALUES ($1, $2, $3, 1000)`,
        [randomUUID(), v2, memberId],
      );
    }
    await client.query(`UPDATE expenses SET current_version_id = $1 WHERE id = $2`, [v2, eid]);
    await client.query('COMMIT');

    expect(await as(grp.profileIds[1] as string, () => countAttachments(eid))).toBe(0); // dropped
    expect(await as(grp.profileIds[0] as string, () => countAttachments(eid))).toBe(1); // still a party
    void versionId;
  });
});

describe('no leak surfaces', () => {
  it('T11 — storage_objects is not client-readable (no key scraping)', async () => {
    await as(g.profileIds[0] as string, async () => {
      const message = await expectDenied(client.query(`SELECT * FROM storage_objects LIMIT 1`));
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('T12 — a restricted path is never a column on the group-visible settlements row', async () => {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'settlements' AND column_name = 'proof_path'`,
    );
    expect(rows).toHaveLength(0);
  });
});
