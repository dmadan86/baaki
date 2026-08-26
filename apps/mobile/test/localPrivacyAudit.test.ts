import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  data: new Map<string, string>(),
  getItem: vi.fn(async (key: string) => storage.data.get(key) ?? null),
}));

const secure = vi.hoisted(() => ({
  data: new Map<string, string>(),
  getItemAsync: vi.fn(async (key: string) => secure.data.get(key) ?? null),
}));

const fs = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  dirs: new Set<string>(),
}));

class FakeDirectory {
  readonly uri: string;

  constructor(...parts: string[]) {
    this.uri = parts.join('/');
  }

  get exists(): boolean {
    return fs.dirs.has(this.uri);
  }

  list(): unknown[] {
    return [...fs.files.keys()]
      .filter((key) => key.startsWith(`${this.uri}/`))
      .map((key) => ({ uri: key }));
  }
}

vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
vi.mock('expo-secure-store', () => ({ getItemAsync: secure.getItemAsync }));
vi.mock('expo-file-system', () => ({
  Directory: FakeDirectory,
  Paths: { document: 'document-root', cache: 'cache-root' },
}));

const { localPrivacyAudit } = await import('../src/lib/localPrivacyAudit');

beforeEach(() => {
  storage.data.clear();
  storage.getItem.mockClear();
  secure.data.clear();
  secure.getItemAsync.mockClear();
  fs.files.clear();
  fs.dirs.clear();
});

describe('localPrivacyAudit', () => {
  it('reports only key/index presence and aggregate private file counts', async () => {
    secure.data.set('waves.mirror.dek.v1', 'dek');
    storage.data.set('receipt-upload-queue.v1', '[]');
    fs.dirs.add('document-root/pending-receipts');
    fs.dirs.add('cache-root/receipt-image-cache');
    fs.files.set('document-root/pending-receipts/a.jpg', new Uint8Array([1]));
    fs.files.set('cache-root/receipt-image-cache/b.jpg', new Uint8Array([2]));
    fs.files.set('cache-root/receipt-image-cache/c.jpg', new Uint8Array([3]));

    await expect(localPrivacyAudit()).resolves.toEqual({
      mirrorKeyPresent: true,
      receiptQueuePresent: true,
      pendingReceiptFiles: 1,
      cachedImageFiles: 2,
    });
  });

  it('reports clean state after sign-out cleanup has removed private local data', async () => {
    await expect(localPrivacyAudit()).resolves.toEqual({
      mirrorKeyPresent: false,
      receiptQueuePresent: false,
      pendingReceiptFiles: 0,
      cachedImageFiles: 0,
    });
  });
});
