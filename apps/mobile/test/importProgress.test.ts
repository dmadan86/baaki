/**
 * The background-import store's state machine (src/lib/importProgress).
 *
 * These assert the transitions the dashboard banner relies on — run → success,
 * the offline park-and-retry, real failures, and the token guards that stop a
 * stale job writing over a newer one — with `expo-network` mocked so "online"
 * and "offline" are ours to drive, and fake timers so the reconnect poll and the
 * success linger do not make the suite wait in real seconds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Network from 'expo-network';

import {
  beginImport,
  dismissImport,
  getImportedGroupId,
  getImportSnapshot,
  type ImportResult,
} from '@/lib/importProgress';

// Hoisted above the imports by vitest, so the store sees the mock — we drive
// "online" / "offline" from each test through `netMock`.
vi.mock('expo-network', () => ({
  getNetworkStateAsync: vi.fn(),
}));

// The store's NET_POLL_MS — the reconnect poll interval. Kept in step with the
// module; the test advances past it to fire a poll.
const NET_POLL_MS = 4000;

const ONLINE = { isInternetReachable: true, isConnected: true } as const;
const OFFLINE = { isInternetReachable: false, isConnected: false } as const;

const netMock = Network.getNetworkStateAsync as unknown as ReturnType<typeof vi.fn>;

/** A promise whose settling this test controls. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const result = (groupId: string): ImportResult => ({
  groupId,
  expenses: 3,
  ghosts: 1,
  settlements: 0,
});

/** Let every pending microtask (awaited isOnline / job.run continuations) run. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  netMock.mockReset();
  netMock.mockResolvedValue(ONLINE);
});

afterEach(() => {
  // Return the module singleton to idle between tests (bumps the guard token,
  // clears any timers), then hand real timers back.
  dismissImport();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('importProgress store', () => {
  it('runs online: idle → running → success, exposing the landed group', async () => {
    const d = deferred<ImportResult>();
    const run = vi.fn(() => d.promise);

    beginImport({ name: 'Goa', run });
    // Shows the banner synchronously, before the reachability check resolves.
    expect(getImportSnapshot().phase).toBe('running');

    await flush(); // isOnline resolves → attempt runs the job
    expect(run).toHaveBeenCalledTimes(1);
    expect(getImportSnapshot().phase).toBe('running');
    expect(getImportedGroupId()).toBeNull();

    d.resolve(result('g1'));
    await flush();

    const snap = getImportSnapshot();
    expect(snap.phase).toBe('success');
    expect(snap.groupId).toBe('g1');
    expect(snap.summary).toEqual({ expenses: 3, ghosts: 1, settlements: 0 });
    expect(getImportedGroupId()).toBe('g1');
  });

  it('clears itself a beat after success', async () => {
    const d = deferred<ImportResult>();
    beginImport({ name: 'Goa', run: () => d.promise });
    await flush();
    d.resolve(result('g1'));
    await flush();
    expect(getImportSnapshot().phase).toBe('success');

    await vi.advanceTimersByTimeAsync(5000);
    expect(getImportSnapshot().phase).toBe('idle');
    expect(getImportedGroupId()).toBeNull();
  });

  it('parks offline, then runs on reconnect', async () => {
    netMock.mockResolvedValue(OFFLINE);
    const d = deferred<ImportResult>();
    const run = vi.fn(() => d.promise);

    beginImport({ name: 'Goa', run });
    await flush(); // isOnline resolves false → park
    expect(getImportSnapshot().phase).toBe('waiting');
    expect(run).not.toHaveBeenCalled();

    // Connection returns; the next poll picks it up and runs the job.
    netMock.mockResolvedValue(ONLINE);
    await vi.advanceTimersByTimeAsync(NET_POLL_MS);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getImportSnapshot().phase).toBe('running');

    d.resolve(result('g2'));
    await flush();
    expect(getImportSnapshot().phase).toBe('success');
    expect(getImportedGroupId()).toBe('g2');
  });

  it('surfaces a real (online) failure as an error with its message', async () => {
    const d = deferred<ImportResult>();
    beginImport({ name: 'Goa', run: () => d.promise });
    await flush();

    d.reject(new Error('That group id is already taken'));
    await flush(); // onFail → isOnline (online) → error

    const snap = getImportSnapshot();
    expect(snap.phase).toBe('error');
    expect(snap.error).toBe('That group id is already taken');
    expect(getImportedGroupId()).toBeNull();
  });

  it('treats a failure while offline as a wait, not an error', async () => {
    const d = deferred<ImportResult>();
    beginImport({ name: 'Goa', run: () => d.promise });
    await flush(); // online → running

    // The connection drops, then the in-flight write rejects.
    netMock.mockResolvedValue(OFFLINE);
    d.reject(new Error('Network request failed'));
    await flush(); // onFail → isOnline (offline) → park

    expect(getImportSnapshot().phase).toBe('waiting');
  });

  it('ignores a second start while one is already running', async () => {
    const first = vi.fn(() => deferred<ImportResult>().promise);
    const second = vi.fn(() => deferred<ImportResult>().promise);

    beginImport({ name: 'One', run: first });
    await flush();
    beginImport({ name: 'Two', run: second });
    await flush();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(getImportSnapshot().groupName).toBe('One');
  });

  it('drops a job dismissed before it resolves — a stale resolve cannot win', async () => {
    const d = deferred<ImportResult>();
    beginImport({ name: 'Goa', run: () => d.promise });
    await flush();
    expect(getImportSnapshot().phase).toBe('running');

    dismissImport();
    expect(getImportSnapshot().phase).toBe('idle');

    // The old job settles late; its token is stale, so nothing changes.
    d.resolve(result('g3'));
    await flush();
    expect(getImportSnapshot().phase).toBe('idle');
    expect(getImportedGroupId()).toBeNull();
  });
});
