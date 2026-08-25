import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueuedMutation } from '@waves/core';

import { createLocalStore } from '../src/sync/driver.web';
import type { StoredRow } from '../src/sync/store';

const mutation = (id: string, groupId = 'g1'): QueuedMutation =>
  ({
    clientMutationId: id,
    seq: id === 'm1' ? 1 : 2,
    kind: 'expense.create',
    groupId,
    clientCreatedAt: '2026-01-01T00:00:00.000Z',
    payload: { expenseId: `e-${id}` },
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
  }) as unknown as QueuedMutation;

const row = (id: string, groupId = 'g1', seq = 1): StoredRow =>
  ({
    table: 'expenses',
    id,
    groupId,
    seq,
    row: { id, group_id: groupId, updated_seq: seq },
  }) as StoredRow;

describe('web local store', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    await AsyncStorage.clear();
  });

  it('round-trips rows, cursors, queue and drafts through AsyncStorage', async () => {
    const store = createLocalStore();

    await store.ready();
    await store.putRows([row('e1', 'g1', 1), row('e2', 'g2', 2)]);
    await store.putRows([row('e1', 'g1', 3)]);
    await store.writeCursors({ g1: 3, g2: 2 });
    await store.writeQueue([mutation('m1'), mutation('m2', 'g2')]);
    await store.writeDraft('later', { amount: 200 });
    await store.writeDraft('earlier', { amount: 100 });

    expect(await store.readRows()).toEqual([row('e1', 'g1', 3), row('e2', 'g2', 2)]);
    expect(await store.readCursors()).toEqual({ g1: 3, g2: 2 });
    expect((await store.readQueue()).map((entry) => entry.clientMutationId)).toEqual(['m1', 'm2']);
    expect(await store.readDraft<{ amount: number }>('later')).toEqual({ amount: 200 });
    expect((await store.listDrafts()).map((draft) => draft.key).sort()).toEqual([
      'earlier',
      'later',
    ]);
  });

  it('forgets one group without touching other groups or replacement queue', async () => {
    const store = createLocalStore();
    await store.putRows([row('e1', 'g1', 1), row('e2', 'g2', 2)]);
    await store.writeCursors({ g1: 1, g2: 2 });
    await store.writeQueue([mutation('m1'), mutation('m2', 'g2')]);

    await store.forgetGroup('g1', [mutation('m2', 'g2')]);

    expect(await store.readRows()).toEqual([row('e2', 'g2', 2)]);
    expect(await store.readCursors()).toEqual({ g2: 2 });
    expect((await store.readQueue()).map((entry) => entry.clientMutationId)).toEqual(['m2']);
  });

  it('clears drafts and resets every persisted collection', async () => {
    const store = createLocalStore();
    await store.putRows([row('e1')]);
    await store.writeCursors({ g1: 1 });
    await store.writeQueue([mutation('m1')]);
    await store.writeDraft('expense:new', { amount: 100 });

    await store.clearDraft('expense:new');
    expect(await store.readDraft('expense:new')).toBeNull();

    await store.writeDraft('expense:new', { amount: 100 });
    await store.reset();

    expect(await store.readRows()).toEqual([]);
    expect(await store.readCursors()).toEqual({});
    expect(await store.readQueue()).toEqual([]);
    expect(await store.listDrafts()).toEqual([]);
  });

  it('treats corrupt or empty JSON as an empty store so the next sync can rebuild it', async () => {
    await AsyncStorage.setItem('baaki:mirror', '{not-json');
    await AsyncStorage.setItem('baaki:cursors', '{not-json');
    await AsyncStorage.setItem('baaki:queue', '{not-json');
    await AsyncStorage.setItem('baaki:drafts', '{not-json');

    const store = createLocalStore();

    expect(await store.readRows()).toEqual([]);
    expect(await store.readCursors()).toEqual({});
    expect(await store.readQueue()).toEqual([]);
    expect(await store.readDraft('missing')).toBeNull();
    expect(await store.listDrafts()).toEqual([]);

    await AsyncStorage.setItem('baaki:mirror', '');
    expect(await store.readRows()).toEqual([]);
  });
});
