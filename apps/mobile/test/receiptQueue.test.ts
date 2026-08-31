import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  data: new Map<string, string>(),
  getItem: vi.fn(async (key: string) => storage.data.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => {
    storage.data.set(key, value);
  }),
  removeItem: vi.fn(async (key: string) => {
    storage.data.delete(key);
  }),
}));

const fs = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  dirs: new Set<string>(),
  failDelete: false,
}));

/** Unique ids per call, so a test can park more than one capture. */
const ids = vi.hoisted(() => ({ n: 0 }));

/** The world outside the queue: the network, R2, and the attach RPC. */
const world = vi.hoisted(() => ({
  online: true,
  put: vi.fn(async (_input: unknown) => 'stored'),
  rpc: vi.fn(async (_name: string, _args: unknown) => ({
    error: null as { message: string } | null,
  })),
  cached: [] as { bucket: string; path: string }[],
}));

class FakeDirectory {
  readonly uri: string;

  constructor(...parts: string[]) {
    this.uri = parts.join('/');
  }

  get exists(): boolean {
    return fs.dirs.has(this.uri);
  }

  create(): void {
    fs.dirs.add(this.uri);
  }

  delete(): void {
    if (fs.failDelete) throw new Error('delete failed');
    fs.dirs.delete(this.uri);
    for (const key of [...fs.files.keys()]) {
      if (key.startsWith(`${this.uri}/`)) fs.files.delete(key);
    }
  }

  list(): FakeFile[] {
    return [...fs.files.keys()]
      .filter((key) => key.startsWith(`${this.uri}/`))
      .map((key) => new FakeFile(key));
  }
}

class FakeFile {
  readonly uri: string;

  constructor(...parts: unknown[]) {
    this.uri = parts
      .map((part) => (part instanceof FakeDirectory ? part.uri : String(part)))
      .join('/');
  }

  get name(): string {
    return this.uri.split('/').pop() ?? this.uri;
  }

  get exists(): boolean {
    return fs.files.has(this.uri);
  }

  write(bytes: Uint8Array): void {
    fs.files.set(this.uri, new Uint8Array(bytes));
  }

  delete(): void {
    if (fs.failDelete) throw new Error('delete failed');
    fs.files.delete(this.uri);
  }

  async base64(): Promise<string> {
    return Buffer.from(fs.files.get(this.uri) ?? new Uint8Array()).toString('base64');
  }
}

vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
vi.mock('expo-crypto', () => ({
  randomUUID: vi.fn(() => {
    ids.n += 1;
    return `uuid${ids.n}`;
  }),
}));
vi.mock('expo-network', () => ({
  getNetworkStateAsync: vi.fn(async () => ({
    isConnected: world.online,
    isInternetReachable: world.online,
  })),
}));
vi.mock('expo-file-system', () => ({
  Directory: FakeDirectory,
  File: FakeFile,
  Paths: { document: 'document-root', cache: 'cache-root' },
}));
vi.mock('@/lib/backend', () => ({
  backend: { rpc: (name: string, args: unknown) => world.rpc(name, args) },
}));
vi.mock('@/lib/storage', () => ({ putImage: (input: unknown) => world.put(input) }));
vi.mock('@/lib/storage/imageCache', () => ({
  cacheImageBytes: vi.fn((bucket: string, path: string) => {
    world.cached.push({ bucket, path });
  }),
}));
vi.mock('@/lib/transferProgress', () => ({
  endTransfer: vi.fn(),
  setTransferProgress: vi.fn(),
  startTransfer: vi.fn(),
}));

const {
  clearReceiptQueue,
  discardPendingReceipt,
  enqueueReceipt,
  flushReceiptQueue,
  getPendingReceiptsSnapshot,
  listPendingReceipts,
  pendingReceiptUri,
  retryPendingReceipts,
  subscribePendingReceipts,
} = await import('../src/lib/receiptQueue');

const QUEUE_KEY = 'receipt-upload-queue.v1';
const pendingPath = (fileName: string) => `document-root/pending-receipts/${fileName}`;

/** A stored entry, as a previous run of the app would have left it. */
const entryFor = (overrides: Partial<Record<string, unknown>> = {}) => ({
  attachmentId: 'a1',
  expenseId: 'e1',
  groupId: 'g1',
  visibility: 'group' as const,
  storagePath: 'e1/a1.jpg',
  contentType: 'image/jpeg',
  fileName: 'a1.jpg',
  createdAt: '2026-01-01T00:00:00Z',
  attempts: 0,
  lastError: null,
  ...overrides,
});

/** Put one capture on disk exactly as a killed run of the app would have. */
function parkOnDisk(overrides: Partial<Record<string, unknown>> = {}): void {
  const entry = entryFor(overrides);
  storage.data.set(QUEUE_KEY, JSON.stringify([entry]));
  fs.dirs.add('document-root/pending-receipts');
  fs.files.set(pendingPath(entry.fileName), new Uint8Array([1, 2, 3]));
}

async function storedQueue(): Promise<Record<string, unknown>[]> {
  return JSON.parse(storage.data.get(QUEUE_KEY) ?? '[]') as Record<string, unknown>[];
}

beforeEach(() => {
  storage.data.clear();
  storage.getItem.mockClear();
  storage.setItem.mockClear();
  storage.removeItem.mockClear();
  fs.files.clear();
  fs.dirs.clear();
  fs.failDelete = false;
  ids.n = 0;
  world.online = true;
  world.cached = [];
  world.put.mockReset();
  world.put.mockImplementation(async () => 'stored');
  world.rpc.mockReset();
  world.rpc.mockImplementation(async () => ({ error: null }));
});

describe('parking a capture', () => {
  it('writes the bytes down and queues the entry before anything is sent', async () => {
    const entry = await enqueueReceipt({
      expenseId: 'e1',
      groupId: 'g1',
      visibility: 'group',
      base64: Buffer.from([7, 8, 9]).toString('base64'),
      contentType: 'image/jpeg',
    });

    // The photograph exists somewhere other than memory from this moment on —
    // which is the whole reason the queue writes before it uploads.
    expect(fs.files.get(pendingPath(entry.fileName))).toEqual(new Uint8Array([7, 8, 9]));
    expect(await listPendingReceipts('e1')).toHaveLength(1);
    expect(world.put).not.toHaveBeenCalled();
    // And it is on screen straight away, as something waiting rather than sent.
    expect(getPendingReceiptsSnapshot().map((item) => item.status)).toEqual(['queued']);
  });

  it('publishes to subscribers as the queue changes', async () => {
    const seen: number[] = [];
    const unsubscribe = subscribePendingReceipts(() => {
      seen.push(getPendingReceiptsSnapshot().length);
    });

    const entry = await enqueueReceipt({
      expenseId: 'e1',
      groupId: 'g1',
      visibility: 'group',
      base64: Buffer.from([1]).toString('base64'),
      contentType: 'image/jpeg',
    });
    await discardPendingReceipt(entry.attachmentId);
    unsubscribe();

    // A gallery three screens away learns about both without asking.
    expect(seen.at(-1)).toBe(0);
    expect(seen).toContain(1);
    expect(fs.files.has(pendingPath(entry.fileName))).toBe(false);
  });
});

describe('resuming an interrupted upload', () => {
  it('picks up a capture left by a previous run of the app and sends it', async () => {
    parkOnDisk();
    // A cold start: a module with no memory of the run that parked this.
    vi.resetModules();
    const fresh = await import('../src/lib/receiptQueue');
    expect(fresh.getPendingReceiptsSnapshot()).toHaveLength(0);

    expect(await fresh.listPendingReceipts()).toHaveLength(1);
    expect(fresh.getPendingReceiptsSnapshot()[0]?.status).toBe('queued');

    const result = await fresh.flushReceiptQueue();

    expect(world.put).toHaveBeenCalledTimes(1);
    expect(world.rpc).toHaveBeenCalledWith('baaki_attach_expense_attachment', {
      p_expense_id: 'e1',
      p_storage_path: 'e1/a1.jpg',
      p_visibility: 'group',
      p_attachment_id: 'a1',
    });
    expect(result.uploadedExpenseIds).toEqual(['e1']);
    // Sent, so the bytes move into the view cache and out of the pending dir.
    expect(world.cached).toEqual([{ bucket: 'expense-attachments', path: 'e1/a1.jpg' }]);
    expect(fs.files.has(pendingPath('a1.jpg'))).toBe(false);
    expect(await storedQueue()).toEqual([]);
  });

  it('says a capture is sending while it is in the air', async () => {
    parkOnDisk();
    let statusMidUpload: string | undefined;
    world.put.mockImplementation(async () => {
      statusMidUpload = getPendingReceiptsSnapshot()[0]?.status;
      return 'stored';
    });

    await listPendingReceipts();
    await flushReceiptQueue();

    expect(statusMidUpload).toBe('uploading');
  });

  it('leaves everything alone and sends nothing while offline', async () => {
    parkOnDisk();
    world.online = false;

    const result = await flushReceiptQueue();

    expect(world.put).not.toHaveBeenCalled();
    expect(result.uploadedExpenseIds).toEqual([]);
    expect(await storedQueue()).toHaveLength(1);
    expect(fs.files.has(pendingPath('a1.jpg'))).toBe(true);
  });

  it('keeps a capture parked when nothing is due yet', async () => {
    // A failure a moment ago; its backoff has not run out.
    parkOnDisk({
      attempts: 1,
      lastError: 'network request failed',
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await flushReceiptQueue();

    expect(world.put).not.toHaveBeenCalled();
    expect(await storedQueue()).toHaveLength(1);
  });
});

describe('a capture that does not go up', () => {
  it('keeps a transient failure, records it, and backs off before trying again', async () => {
    parkOnDisk();
    world.put.mockRejectedValue(new Error('Network request failed'));

    const first = await flushReceiptQueue();

    expect(first.uploadedExpenseIds).toEqual([]);
    expect(first.hadPermanentFailure).toBe(false);
    const [stored] = await storedQueue();
    expect(stored).toMatchObject({ attempts: 1, permanent: false });
    expect(stored?.lastError).toContain('Network request failed');
    expect(Date.parse(String(stored?.nextAttemptAt))).toBeGreaterThan(Date.now());
    // The bytes are still there — a failed send never costs the photograph.
    expect(fs.files.has(pendingPath('a1.jpg'))).toBe(true);
    expect(getPendingReceiptsSnapshot()[0]?.status).toBe('failed');

    // A second flush straight away respects the backoff rather than hammering.
    await flushReceiptQueue();
    expect(world.put).toHaveBeenCalledTimes(1);
  });

  it('keeps a refusal visible instead of dropping it, and never retries it by itself', async () => {
    parkOnDisk();
    world.rpc.mockResolvedValue({ error: { message: 'ATTACHMENT_CAP reached' } });

    const result = await flushReceiptQueue();

    expect(result.hadPermanentFailure).toBe(true);
    expect(result.capReached).toBe(true);
    const [stored] = await storedQueue();
    expect(stored).toMatchObject({ permanent: true, nextAttemptAt: null });
    // Still on the phone, still on screen: a receipt that vanished with no
    // explanation is indistinguishable from a bug.
    expect(fs.files.has(pendingPath('a1.jpg'))).toBe(true);
    expect(getPendingReceiptsSnapshot()[0]?.status).toBe('failed');

    await flushReceiptQueue();
    expect(world.put).toHaveBeenCalledTimes(1);
  });

  it('sends a refused capture again when the person asks', async () => {
    parkOnDisk();
    world.rpc.mockResolvedValueOnce({ error: { message: 'ATTACHMENT_CAP reached' } });
    await flushReceiptQueue();
    expect(await storedQueue()).toHaveLength(1);

    // Somebody removed another receipt and tapped "try again": the backoff, the
    // recorded failure and the refusal mark are all cleared for this one.
    const result = await retryPendingReceipts(['a1']);

    expect(result.uploadedExpenseIds).toEqual(['e1']);
    expect(world.put).toHaveBeenCalledTimes(2);
    expect(await storedQueue()).toEqual([]);
  });

  it('drops an entry whose bytes are gone rather than retrying forever', async () => {
    storage.data.set(QUEUE_KEY, JSON.stringify([entryFor()]));

    await flushReceiptQueue();

    expect(world.put).not.toHaveBeenCalled();
    expect(await storedQueue()).toEqual([]);
  });
});

describe('a capture parked while a flush is running', () => {
  it('survives the write-back instead of being silently dropped', async () => {
    parkOnDisk();
    let latecomerFile = '';
    world.put.mockImplementation(async () => {
      const late = await enqueueReceipt({
        expenseId: 'e2',
        groupId: 'g1',
        visibility: 'group',
        base64: Buffer.from([4]).toString('base64'),
        contentType: 'image/jpeg',
      });
      latecomerFile = late.fileName;
      return 'stored';
    });

    await flushReceiptQueue();

    const queue = await storedQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ expenseId: 'e2' });
    // Its bytes are still under the pending dir — not orphaned by the write-back.
    expect(fs.files.has(pendingPath(latecomerFile))).toBe(true);
  });
});

describe('receipt queue local privacy cleanup', () => {
  it('removes the queue index and pending receipt files on sign-out cleanup', async () => {
    const entries = [
      entryFor(),
      entryFor({
        attachmentId: 'a2',
        expenseId: 'e2',
        visibility: 'parties',
        storagePath: 'e2/a2.jpg',
        fileName: 'a2.jpg',
        createdAt: '2026-01-01T00:00:01Z',
        attempts: 1,
        lastError: 'offline',
      }),
    ];
    storage.data.set(QUEUE_KEY, JSON.stringify(entries));
    fs.dirs.add('document-root/pending-receipts');
    fs.files.set(pendingPath('a1.jpg'), new Uint8Array([1]));
    fs.files.set(pendingPath('a2.jpg'), new Uint8Array([2]));

    await clearReceiptQueue();

    expect(storage.removeItem).toHaveBeenCalledWith(QUEUE_KEY);
    expect(await listPendingReceipts()).toEqual([]);
    expect(getPendingReceiptsSnapshot()).toEqual([]);
    expect(fs.files.has(pendingPath('a1.jpg'))).toBe(false);
    expect(fs.files.has(pendingPath('a2.jpg'))).toBe(false);
    expect(fs.dirs.has('document-root/pending-receipts')).toBe(false);
  });

  it('still removes the queue index when file deletion fails', async () => {
    storage.data.set(QUEUE_KEY, JSON.stringify([entryFor()]));
    fs.dirs.add('document-root/pending-receipts');
    fs.files.set(pendingPath('a1.jpg'), new Uint8Array([1]));
    fs.failDelete = true;

    await clearReceiptQueue();

    expect(storage.removeItem).toHaveBeenCalledWith(QUEUE_KEY);
    expect(await listPendingReceipts()).toEqual([]);
    expect(pendingReceiptUri(entryFor())).toBe(pendingPath('a1.jpg'));
  });

  it('removes orphan pending files when pending receipts are listed', async () => {
    storage.data.set(QUEUE_KEY, JSON.stringify([entryFor()]));
    fs.dirs.add('document-root/pending-receipts');
    fs.files.set(pendingPath('a1.jpg'), new Uint8Array([1]));
    fs.files.set(pendingPath('orphan.jpg'), new Uint8Array([9]));

    await expect(listPendingReceipts()).resolves.toEqual([entryFor()]);

    expect(fs.files.has(pendingPath('a1.jpg'))).toBe(true);
    expect(fs.files.has(pendingPath('orphan.jpg'))).toBe(false);
  });
});
