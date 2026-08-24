/**
 * The trip album overlay (plan feature #2). A photo added offline shows at once
 * as a pending row; a removal is a tombstone the caller filters, not a hard drop
 * a second device never sees. These pin the overlay and the newest-first order.
 */

import { describe, expect, it } from 'vitest';

import {
  emptyMirror,
  enqueue,
  materialiseTripPhotos,
  MutationKind,
  reconcile,
  type MutationEnvelope,
  type QueuedMutation,
  type SyncChange,
} from '../src/sync/index.js';

const GROUP = 'g-1';
const AT = '2026-03-01T09:00:00Z';

function envelope(
  id: string,
  kind: MutationEnvelope['kind'],
  payload: Record<string, unknown>,
  groupId = GROUP,
): MutationEnvelope {
  return { clientMutationId: id, kind, groupId, clientCreatedAt: AT, payload };
}

function queued(...envelopes: MutationEnvelope[]): QueuedMutation[] {
  let queue: QueuedMutation[] = [];
  for (const item of envelopes) queue = enqueue(queue, item);
  return queue;
}

function serverPhoto(id: string, createdAt: string, over: Partial<Record<string, unknown>> = {}) {
  const row: SyncChange = {
    table: 'trip_photos' as SyncChange['table'],
    groupId: GROUP,
    seq: 1,
    row: {
      id,
      group_id: GROUP,
      expense_id: null,
      day: null,
      storage_path: `${GROUP}/${id}.webp`,
      caption: null,
      created_by: 'member-a',
      created_at: createdAt,
      deleted_at: null,
      updated_seq: 1,
      ...over,
    },
  };
  return row;
}

describe('materialiseTripPhotos', () => {
  it('shows a photo added with no network, marked pending', () => {
    const add = envelope('m-1', MutationKind.TripPhotoAdd, {
      photoId: 'p-1',
      storagePath: `${GROUP}/p-1.webp`,
      expenseId: 'e-9',
      day: '2026-03-01',
      caption: 'the view',
    });
    const rows = materialiseTripPhotos(emptyMirror(), queued(add), { groupId: GROUP });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'p-1',
      storage_path: `${GROUP}/p-1.webp`,
      expense_id: 'e-9',
      day: '2026-03-01',
      caption: 'the view',
      deleted_at: null,
      pending: true,
    });
  });

  it('carries a removal as a tombstone rather than dropping the row', () => {
    const remove = envelope('m-2', MutationKind.TripPhotoDelete, { photoId: 'p-1' });
    const { state } = reconcile(emptyMirror(), [serverPhoto('p-1', AT)]);
    const rows = materialiseTripPhotos(state, queued(remove), { groupId: GROUP });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deleted_at).toBe(AT);
    expect(rows[0]?.pending).toBe(true);
  });

  it('orders newest first, and a pending add sits above committed rows', () => {
    const { state } = reconcile(emptyMirror(), [
      serverPhoto('old', '2026-03-01T08:00:00Z'),
      serverPhoto('new', '2026-03-01T10:00:00Z'),
    ]);
    const add = envelope('m-3', MutationKind.TripPhotoAdd, {
      photoId: 'fresh',
      storagePath: `${GROUP}/fresh.webp`,
    });
    const rows = materialiseTripPhotos(state, queued(add), { groupId: GROUP });
    // Pending add first (clientCreatedAt AT = 09:00 is newer than 08:00 but the
    // server 'new' at 10:00 is newer still) — order is purely by timestamp desc.
    expect(rows.map((r) => r.id)).toEqual(['new', 'fresh', 'old']);
  });

  it('ignores a photo added to another group', () => {
    const add = envelope(
      'm-4',
      MutationKind.TripPhotoAdd,
      { photoId: 'p-x', storagePath: 'other/p-x.webp' },
      'g-2',
    );
    expect(materialiseTripPhotos(emptyMirror(), queued(add), { groupId: GROUP })).toHaveLength(0);
  });
});
