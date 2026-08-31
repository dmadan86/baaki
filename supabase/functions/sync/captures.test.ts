/**
 * A capture create that arrives twice must not fail (A34).
 *
 * `captures.id` is minted on the phone, so the same create can reach the server
 * more than once: the first attempt lands but its reply is lost, or the
 * `sync_mutations` row that records the outcome fails to write, and the phone
 * (or a person tapping Save again on the error) sends it once more under a fresh
 * mutation id — which slips past the replay guard keyed on that id. Before this
 * was handled the second attempt came back as a rejection carrying the raw
 * Postgres text:
 *
 *   23505 duplicate key value violates unique constraint "captures_pkey"
 *
 * which the phone showed as a failed save for a capture that was, in fact,
 * already saved. Three of them landed in one 27-second window in production.
 *
 * The session is driven directly with a stubbed Supabase client: no Deno, no
 * network, no database. What is asserted is the contract the client relies on —
 * a duplicate of *your own* capture is a success, a duplicate of somebody
 * else's id is refused, and neither case writes over the existing row.
 */

import { describe, expect, it, vi } from 'vitest';

import { SyncSession } from './index.ts';

const OWNER = 'owner-profile-id';
const CAPTURE_ID = '11111111-2222-3333-4444-555555555555';

const DUPLICATE_KEY = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "captures_pkey"',
};

interface CallerOptions {
  /** The error `insert` reports, or null for a clean first write. */
  insertError?: { code: string; message: string } | null;
  /** What a select of the conflicting id returns — null when RLS hides it. */
  existing?: { id: string } | null;
}

/**
 * The caller-scoped client: `insert` records what it was handed, `select` answers
 * the ownership question the duplicate path asks. Chainable like PostgREST's
 * builder so the code under test reads unchanged.
 */
function caller(options: CallerOptions = {}) {
  const insert = vi.fn(() => Promise.resolve({ error: options.insertError ?? null }));
  const maybeSingle = vi.fn(() => Promise.resolve({ data: options.existing ?? null, error: null }));
  const from = vi.fn(() => {
    const builder: Record<string, unknown> = { insert };
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.maybeSingle = maybeSingle;
    return builder;
  });
  return { client: { from } as never, insert, maybeSingle, from };
}

/** The service-role client: the replay guard's own table, and nothing else. */
function service(seen: { result: unknown } | null = null) {
  const insert = vi.fn(() => Promise.resolve({ error: null }));
  const from = vi.fn(() => {
    const builder: Record<string, unknown> = { insert };
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.maybeSingle = () => Promise.resolve({ data: seen, error: null });
    return builder;
  });
  return { client: { from } as never, insert };
}

function createCapture(clientMutationId: string) {
  return {
    clientMutationId,
    kind: 'capture.create',
    groupId: OWNER,
    seq: 1,
    clientCreatedAt: '2026-08-31T20:45:11.000Z',
    payload: {
      captureId: CAPTURE_ID,
      description: 'Chai',
      expenseDate: '2026-08-31',
      currency: 'inr',
      amount: '2000',
    },
  } as never;
}

describe('capture.create arriving twice', () => {
  it('accepts a first write and reports the capture id', async () => {
    const scoped = caller();
    const session = new SyncSession(scoped.client, service().client, OWNER);

    const outcome = await session.apply(createCapture('mutation-1'));

    expect(outcome).toMatchObject({ status: 'applied', result: { captureId: CAPTURE_ID } });
    expect(scoped.insert).toHaveBeenCalledTimes(1);
  });

  it('treats a duplicate of the caller’s own capture as already applied', async () => {
    // The row is there and RLS lets the caller see it: their own retry.
    const scoped = caller({ insertError: DUPLICATE_KEY, existing: { id: CAPTURE_ID } });
    const session = new SyncSession(scoped.client, service().client, OWNER);

    const outcome = await session.apply(createCapture('mutation-2'));

    expect(outcome).toMatchObject({ status: 'applied', result: { captureId: CAPTURE_ID } });
    // The whole point: acknowledged, never written over. An upsert here would
    // reset an already-assigned capture's fields and put it back in the inbox.
    expect(scoped.insert).toHaveBeenCalledTimes(1);
  });

  it('refuses a duplicate id that belongs to somebody else', async () => {
    // The insert conflicts but the row is invisible to the caller — the id is in
    // another person's inbox, and answering "fine" would be a lie.
    const scoped = caller({ insertError: DUPLICATE_KEY, existing: null });
    const session = new SyncSession(scoped.client, service().client, OWNER);

    const outcome = await session.apply(createCapture('mutation-3'));

    expect(outcome).toMatchObject({ status: 'rejected', code: 'CAPTURE_ID_TAKEN' });
  });

  it('still rejects a genuine validation failure', async () => {
    const scoped = caller({
      insertError: { code: '23514', message: 'violates check constraint "captures_amount_check"' },
    });
    const session = new SyncSession(scoped.client, service().client, OWNER);

    const outcome = await session.apply(createCapture('mutation-4'));

    expect(outcome).toMatchObject({ status: 'rejected' });
    expect(scoped.maybeSingle).not.toHaveBeenCalled();
  });
});
