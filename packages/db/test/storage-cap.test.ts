/**
 * The R2 image-storage ledger and the free-tier byte ceiling (A44 / ADR-011).
 *
 * Supabase Storage counted and sized objects for free; R2 is opaque to Postgres,
 * so `storage_objects` has to hold that truth and the cap has to be enforced in
 * SQL. These pin the rules the ledger encodes:
 *
 *   - a free account is held under `free_storage_cap_bytes` across every image;
 *   - a paid uploader, and any image in a paid-owned group, never count;
 *   - a reservation (`put`) charges the cap immediately, so "presign forever,
 *     commit never" cannot fill R2 for free;
 *   - two uploads racing the ceiling are serialised — they cannot both slip
 *     under it (the TOCTOU the naive check had);
 *   - every removed object, cascade included, is queued for R2 reclamation.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { CONNECTION_STRING, connect, big } from './helpers.js';

const CAP = 10 * 1024 * 1024; // free_storage_cap_bytes default
const MB = 1024 * 1024;

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client?.end();
});

// Every test builds its own profiles/groups; wipe the ledger + queue between
// them so a stale reservation cannot leak a byte tally into the next test.
afterEach(async () => {
  await client.query(`DELETE FROM storage_orphans`);
  await client.query(`DELETE FROM storage_objects`);
});

async function makeProfile(): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO profiles (id, display_name, default_currency) VALUES ($1, 'X', 'INR')`,
    [id],
  );
  return id;
}

async function makeGroup(ownerId: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO groups (id, name, type, default_currency, created_by) VALUES ($1, 'G', 'trip', 'INR', $2)`,
    [id, ownerId],
  );
  await client.query(
    `INSERT INTO group_members (id, group_id, profile_id, role, joined_via)
     VALUES ($1, $2, $3, 'admin', 'creator')`,
    [randomUUID(), id, ownerId],
  );
  return id;
}

async function makePaid(profileId: string): Promise<void> {
  await client.query(
    `INSERT INTO subscriptions (profile_id, tier, period, status, current_period_end, store)
     VALUES ($1, 'plus', 'monthly', 'active', now() + interval '30 days', 'play')`,
    [profileId],
  );
}

/** Call a SECURITY DEFINER ledger function; the test connects as the owner. */
async function reserve(
  profileId: string,
  groupId: string | null,
  bucket: string,
  path: string,
  bytes: number,
): Promise<void> {
  await client.query(`SELECT public.baaki_storage_reserve($1,$2,$3,$4,$5,'image/webp')`, [
    profileId,
    groupId,
    bucket,
    path,
    bytes,
  ]);
}

async function record(
  profileId: string,
  groupId: string | null,
  bucket: string,
  path: string,
  bytes: number,
): Promise<void> {
  await client.query(`SELECT public.baaki_storage_record($1,$2,$3,$4,$5,'image/webp')`, [
    profileId,
    groupId,
    bucket,
    path,
    bytes,
  ]);
}

/** Usage as the caller sees it, via the caller-scoped RPC (needs a JWT claim). */
async function usage(profileId: string): Promise<{ used: bigint; cap: bigint }> {
  // Session-scoped (false), not transaction-local: with autocommit a `true`
  // setting would be gone by the time the next statement — the RPC — runs.
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: profileId, role: 'authenticated' }),
  ]);
  const { rows } = await client.query(
    `SELECT used_bytes, cap_bytes FROM public.baaki_my_storage_usage()`,
  );
  await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
  return { used: big(rows[0].used_bytes), cap: big(rows[0].cap_bytes) };
}

async function countedSum(profileId: string): Promise<bigint> {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(bytes),0) AS s FROM storage_objects WHERE owner_profile_id = $1 AND counted`,
    [profileId],
  );
  return big(rows[0].s);
}

describe('the free-tier storage ceiling', () => {
  it('lets a free account reserve up to the cap and refuses the byte over it', async () => {
    const p = await makeProfile();

    // Sits exactly at the ceiling: allowed.
    await expect(reserve(p, null, 'avatars', `${p}/a.webp`, CAP)).resolves.toBeUndefined();

    // One more byte on top (a different object) is refused.
    await expect(reserve(p, null, 'avatars', `${p}/b.webp`, 1)).rejects.toThrow(/STORAGE_CAP/);
  });

  it('counts a reservation before it is committed', async () => {
    const p = await makeProfile();
    await reserve(p, null, 'receipts', 'personal/x/1.webp', 6 * MB);

    // 6 MB reserved, uncommitted — a second 6 MB must already be refused.
    await expect(reserve(p, null, 'receipts', 'personal/x/2.webp', 6 * MB)).rejects.toThrow(
      /STORAGE_CAP/,
    );

    const seen = await usage(p);
    expect(seen.used).toBe(BigInt(6 * MB)); // the meter shows in-flight bytes too
    expect(seen.cap).toBe(BigInt(CAP));
  });

  it('commit clears pending and corrects the size to the true bytes', async () => {
    const p = await makeProfile();
    await reserve(p, null, 'avatars', `${p}/a.webp`, 3 * MB); // declared
    await record(p, null, 'avatars', `${p}/a.webp`, 2 * MB); // true, smaller

    const { rows } = await client.query(
      `SELECT bytes, pending FROM storage_objects WHERE path = $1`,
      [`${p}/a.webp`],
    );
    expect(big(rows[0].bytes)).toBe(BigInt(2 * MB));
    expect(rows[0].pending).toBe(false);
    expect(await countedSum(p)).toBe(BigInt(2 * MB));
  });

  it('measures a re-upload as the delta, not double', async () => {
    const p = await makeProfile();
    await record(p, null, 'group-photos', `g/cover.webp`, 8 * MB);
    // Replacing the same object with another 8 MB must not read as 16 MB.
    await expect(reserve(p, null, 'group-photos', `g/cover.webp`, 8 * MB)).resolves.toBeUndefined();
    await record(p, null, 'group-photos', `g/cover.webp`, 8 * MB);
    expect(await countedSum(p)).toBe(BigInt(8 * MB));
  });
});

describe('who is exempt from the ceiling', () => {
  it('never counts a paid uploader', async () => {
    const p = await makeProfile();
    await makePaid(p);
    await record(p, null, 'receipts', 'personal/x/big.webp', 9 * MB);
    await record(p, null, 'avatars', `${p}/a.webp`, 9 * MB);

    expect(await countedSum(p)).toBe(0n); // paid bytes are never counted
    const seen = await usage(p);
    expect(seen.used).toBe(0n);
  });

  it('never counts an image in a paid-owned group, even for a free member', async () => {
    const owner = await makeProfile();
    await makePaid(owner);
    const groupId = await makeGroup(owner);

    const freeMember = await makeProfile();
    await client.query(
      `INSERT INTO group_members (id, group_id, profile_id, role, joined_via)
       VALUES ($1, $2, $3, 'member', 'invite')`,
      [randomUUID(), groupId, freeMember],
    );

    // A free member uploads a 9 MB receipt into the paid group: uncounted.
    await record(freeMember, groupId, 'receipts', `${groupId}/r.webp`, 9 * MB);
    expect(await countedSum(freeMember)).toBe(0n);

    // The same member's *personal* image still counts against them.
    await record(freeMember, null, 'avatars', `${freeMember}/a.webp`, 9 * MB);
    expect(await countedSum(freeMember)).toBe(BigInt(9 * MB));
  });
});

describe('abandoned reservations', () => {
  it('caps how many an account can hold at once', async () => {
    const p = await makeProfile();
    for (let i = 0; i < 8; i += 1) {
      await reserve(p, null, 'receipts', `personal/x/${i}.webp`, 1);
    }
    // The ninth in-flight reservation is refused.
    await expect(reserve(p, null, 'receipts', 'personal/x/9.webp', 1)).rejects.toThrow(
      /TOO_MANY_PENDING/,
    );
  });

  it('expiry frees the held cap and queues the R2 key for reclamation', async () => {
    const p = await makeProfile();
    await reserve(p, null, 'avatars', `${p}/a.webp`, 6 * MB);
    // Age it past the grace window.
    await client.query(
      `UPDATE storage_objects SET updated_at = now() - interval '1 hour' WHERE path = $1`,
      [`${p}/a.webp`],
    );

    const { rows } = await client.query(`SELECT public.baaki_storage_expire_pending() AS n`);
    expect(rows[0].n).toBe(1);
    expect(await countedSum(p)).toBe(0n); // cap freed

    // The trigger queued its key for the sweep.
    const orphan = await client.query(`SELECT 1 FROM storage_orphans WHERE path = $1`, [
      `${p}/a.webp`,
    ]);
    expect(orphan.rowCount).toBe(1);
  });
});

describe('reclaiming stranded R2 bytes', () => {
  it('queues an orphan when a ledger row is released', async () => {
    const p = await makeProfile();
    await record(p, null, 'avatars', `${p}/a.webp`, 1 * MB);
    await client.query(`SELECT public.baaki_storage_release('avatars', $1)`, [`${p}/a.webp`]);

    const orphan = await client.query(`SELECT 1 FROM storage_orphans WHERE path = $1`, [
      `${p}/a.webp`,
    ]);
    expect(orphan.rowCount).toBe(1);

    // ...and clearing it (post R2 delete) empties the queue.
    await client.query(`SELECT public.baaki_storage_orphan_clear('avatars', $1)`, [`${p}/a.webp`]);
    const after = await client.query(`SELECT 1 FROM storage_orphans WHERE path = $1`, [
      `${p}/a.webp`,
    ]);
    expect(after.rowCount).toBe(0);
  });

  it('queues an orphan when the owning profile is deleted (cascade)', async () => {
    const p = await makeProfile();
    await record(p, null, 'avatars', `${p}/a.webp`, 1 * MB);

    // Deleting the profile cascades the ledger row away; the R2 key must survive
    // in the queue or its bytes would be stranded forever.
    await client.query(`DELETE FROM profiles WHERE id = $1`, [p]);

    const gone = await client.query(`SELECT 1 FROM storage_objects WHERE path = $1`, [
      `${p}/a.webp`,
    ]);
    expect(gone.rowCount).toBe(0);
    const orphan = await client.query(`SELECT 1 FROM storage_orphans WHERE path = $1`, [
      `${p}/a.webp`,
    ]);
    expect(orphan.rowCount).toBe(1);
  });
});

describe('the caller-scoped usage RPC', () => {
  it('reveals only the caller’s own tally', async () => {
    const me = await makeProfile();
    const other = await makeProfile();
    await record(me, null, 'avatars', `${me}/a.webp`, 2 * MB);
    await record(other, null, 'avatars', `${other}/a.webp`, 7 * MB);

    const mine = await usage(me);
    expect(mine.used).toBe(BigInt(2 * MB)); // not 9 — the other account is invisible
  });
});

describe('two uploads racing the ceiling', () => {
  it('serialises them so they cannot both slip under it', async () => {
    // 10 MB cap, two 6 MB commits fired at once: the advisory lock forces one to
    // see the other's bytes, so exactly one lands and one is refused.
    const p = await makeProfile();

    const a = new Client({ connectionString: CONNECTION_STRING });
    const b = new Client({ connectionString: CONNECTION_STRING });
    await a.connect();
    await b.connect();

    // Each session, in its own transaction, reserves then commits 6 MB. The
    // per-owner advisory lock is held for the whole transaction, so B blocks
    // until A commits, then re-reads and finds A's 6 MB already there.
    const attempt = (c: Client, path: string) =>
      (async () => {
        await c.query('BEGIN');
        try {
          await c.query(
            `SELECT public.baaki_storage_reserve($1,NULL,'avatars',$2,$3,'image/webp')`,
            [p, path, 6 * MB],
          );
          await c.query(
            `SELECT public.baaki_storage_record($1,NULL,'avatars',$2,$3,'image/webp')`,
            [p, path, 6 * MB],
          );
          await c.query('COMMIT');
          return 'ok';
        } catch (error) {
          await c.query('ROLLBACK');
          throw error;
        }
      })();

    const results = await Promise.allSettled([
      attempt(a, `${p}/one.webp`),
      attempt(b, `${p}/two.webp`),
    ]);
    await a.end();
    await b.end();

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter(
      (r) =>
        r.status === 'rejected' && /STORAGE_CAP/.test(String((r as PromiseRejectedResult).reason)),
    ).length;

    expect(ok).toBe(1); // exactly one upload landed
    expect(failed).toBe(1); // the other was refused by the cap
    expect(await countedSum(p)).toBe(BigInt(6 * MB)); // never 12
  });
});
