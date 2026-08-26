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
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn(() => 'uuid') }));
vi.mock('expo-network', () => ({
  getNetworkStateAsync: vi.fn(async () => ({ isConnected: false })),
}));
vi.mock('expo-file-system', () => ({
  Directory: FakeDirectory,
  File: FakeFile,
  Paths: { document: 'document-root', cache: 'cache-root' },
}));
vi.mock('@/lib/backend', () => ({ backend: { rpc: vi.fn() } }));
vi.mock('@/lib/storage', () => ({ putImage: vi.fn() }));
vi.mock('@/lib/storage/imageCache', () => ({ cacheImageBytes: vi.fn() }));
vi.mock('@/lib/transferProgress', () => ({
  endTransfer: vi.fn(),
  setTransferProgress: vi.fn(),
  startTransfer: vi.fn(),
}));

const { clearReceiptQueue, listPendingReceipts, pendingReceiptUri } =
  await import('../src/lib/receiptQueue');

const QUEUE_KEY = 'receipt-upload-queue.v1';
const pendingPath = (fileName: string) => `document-root/pending-receipts/${fileName}`;

beforeEach(() => {
  storage.data.clear();
  storage.getItem.mockClear();
  storage.setItem.mockClear();
  storage.removeItem.mockClear();
  fs.files.clear();
  fs.dirs.clear();
  fs.failDelete = false;
});

describe('receipt queue local privacy cleanup', () => {
  it('removes the queue index and pending receipt files on sign-out cleanup', async () => {
    const entries = [
      {
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
      },
      {
        attachmentId: 'a2',
        expenseId: 'e2',
        groupId: 'g1',
        visibility: 'parties' as const,
        storagePath: 'e2/a2.jpg',
        contentType: 'image/jpeg',
        fileName: 'a2.jpg',
        createdAt: '2026-01-01T00:00:01Z',
        attempts: 1,
        lastError: 'offline',
      },
    ];
    storage.data.set(QUEUE_KEY, JSON.stringify(entries));
    fs.dirs.add('document-root/pending-receipts');
    fs.files.set(pendingPath('a1.jpg'), new Uint8Array([1]));
    fs.files.set(pendingPath('a2.jpg'), new Uint8Array([2]));

    await clearReceiptQueue();

    expect(storage.removeItem).toHaveBeenCalledWith(QUEUE_KEY);
    expect(await listPendingReceipts()).toEqual([]);
    expect(fs.files.has(pendingPath('a1.jpg'))).toBe(false);
    expect(fs.files.has(pendingPath('a2.jpg'))).toBe(false);
    expect(fs.dirs.has('document-root/pending-receipts')).toBe(false);
  });

  it('still removes the queue index when file deletion fails', async () => {
    const entry = {
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
    };
    storage.data.set(QUEUE_KEY, JSON.stringify([entry]));
    fs.dirs.add('document-root/pending-receipts');
    fs.files.set(pendingPath('a1.jpg'), new Uint8Array([1]));
    fs.failDelete = true;

    await clearReceiptQueue();

    expect(storage.removeItem).toHaveBeenCalledWith(QUEUE_KEY);
    expect(await listPendingReceipts()).toEqual([]);
    expect(pendingReceiptUri(entry)).toBe(pendingPath('a1.jpg'));
  });

  it('removes orphan pending files when pending receipts are listed', async () => {
    const entry = {
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
    };
    storage.data.set(QUEUE_KEY, JSON.stringify([entry]));
    fs.dirs.add('document-root/pending-receipts');
    fs.files.set(pendingPath('a1.jpg'), new Uint8Array([1]));
    fs.files.set(pendingPath('orphan.jpg'), new Uint8Array([9]));

    await expect(listPendingReceipts()).resolves.toEqual([entry]);

    expect(fs.files.has(pendingPath('a1.jpg'))).toBe(true);
    expect(fs.files.has(pendingPath('orphan.jpg'))).toBe(false);
  });
});
