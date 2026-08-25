import { beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  dirs: new Set<string>(),
  fetch: vi.fn(),
  uuid: vi.fn(),
  failCreate: false,
  failWrite: false,
  failMove: false,
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
    if (fs.failCreate) throw new Error('mkdir failed');
    fs.dirs.add(this.uri);
  }
}

class FakeFile {
  readonly uri: string;

  constructor(...parts: unknown[]) {
    this.uri = parts
      .map((part) => (part instanceof FakeDirectory ? part.uri : String(part)))
      .join('/');
  }

  get exists(): boolean {
    return fs.files.has(this.uri);
  }

  write(bytes: Uint8Array): void {
    if (fs.failWrite) throw new Error('write failed');
    fs.files.set(this.uri, new Uint8Array(bytes));
  }

  moveSync(file: FakeFile, options?: { overwrite?: boolean }): void {
    if (fs.failMove) throw new Error('move failed');
    if (!this.exists) throw new Error('source missing');
    if (file.exists && !options?.overwrite) throw new Error('target exists');
    fs.files.set(file.uri, fs.files.get(this.uri) as Uint8Array);
    fs.files.delete(this.uri);
  }

  delete(): void {
    if (fs.failDelete) throw new Error('delete failed');
    fs.files.delete(this.uri);
  }
}

vi.mock('expo-crypto', () => ({ randomUUID: fs.uuid }));
vi.mock('expo/fetch', () => ({ fetch: fs.fetch }));
vi.mock('expo-file-system', () => ({
  Directory: FakeDirectory,
  File: FakeFile,
  Paths: { cache: 'cache-root' },
}));

const { cacheImage, cachedImageUri, cacheImageBytes, evictImage } =
  await import('../src/lib/storage/imageCache');

const cachedPath = (path: string) =>
  `cache-root/receipt-image-cache/${encodeURIComponent(`expense-attachments\u0000${path}`)}`;

beforeEach(() => {
  fs.files.clear();
  fs.dirs.clear();
  fs.fetch.mockReset();
  fs.uuid.mockReset();
  fs.uuid.mockReturnValue('uuid-1');
  fs.failCreate = false;
  fs.failWrite = false;
  fs.failMove = false;
  fs.failDelete = false;
});

describe('image cache', () => {
  it('returns null for empty paths and filesystem errors', async () => {
    expect(cachedImageUri('expense-attachments', null)).toBeNull();
    expect(cachedImageUri('expense-attachments', '')).toBeNull();
    expect(cacheImageBytes('expense-attachments', ' ', new Uint8Array([1]))).toBeNull();
    await expect(
      cacheImage('expense-attachments', '', 'https://signed.example/blank'),
    ).resolves.toBeNull();
    expect(fs.fetch).not.toHaveBeenCalled();

    fs.failCreate = true;
    expect(cacheImageBytes('expense-attachments', 'g1/e1.png', new Uint8Array([1]))).toBeNull();
    expect(cachedImageUri('expense-attachments', 'g1/e1.png')).toBeNull();
  });

  it('encodes bucket and path into one stable collision-safe flat filename', () => {
    const bytes = new Uint8Array([1, 2, 3]);

    const uri = cacheImageBytes('expense-attachments', 'groups/g1/receipt #1.webp', bytes);

    expect(uri).toBe(cachedPath('groups/g1/receipt #1.webp'));
    expect(cachedImageUri('expense-attachments', 'groups/g1/receipt #1.webp')).toBe(uri);
  });

  it('keeps paths distinct when lossy filename sanitizing would collide', () => {
    const slash = cacheImageBytes('expense-attachments', 'g1/a/b.png', new Uint8Array([1]));
    const underscore = cacheImageBytes('expense-attachments', 'g1/a_b.png', new Uint8Array([2]));

    expect(slash).not.toBe(underscore);
    expect(Array.from(fs.files.get(cachedPath('g1/a/b.png')) ?? [])).toEqual([1]);
    expect(Array.from(fs.files.get(cachedPath('g1/a_b.png')) ?? [])).toEqual([2]);
  });

  it('downloads once, then serves cache hits without another network call', async () => {
    fs.fetch.mockResolvedValue({ ok: true, bytes: async () => new Uint8Array([7, 8, 9]) });

    const first = await cacheImage('expense-attachments', 'g1/e1.png', 'https://signed.example/e1');
    const second = await cacheImage(
      'expense-attachments',
      'g1/e1.png',
      'https://signed.example/e1?v=2',
    );

    expect(first).toBe(cachedPath('g1/e1.png'));
    expect(second).toBe(first);
    expect(fs.fetch).toHaveBeenCalledTimes(1);
    expect([...fs.files.keys()].filter((key) => key.endsWith('.tmp'))).toEqual([]);
  });

  it('dedupes concurrent downloads for the same cache key', async () => {
    let release: (bytes: Uint8Array) => void = () => {};
    fs.fetch.mockResolvedValue({
      ok: true,
      bytes: () =>
        new Promise<Uint8Array>((resolve) => {
          release = resolve;
        }),
    });

    const first = cacheImage('expense-attachments', 'g1/e1.png', 'https://signed.example/e1');
    const second = cacheImage('expense-attachments', 'g1/e1.png', 'https://signed.example/e1?v=2');
    await Promise.resolve();
    release(new Uint8Array([7, 8, 9]));

    await expect(Promise.all([first, second])).resolves.toEqual([
      cachedPath('g1/e1.png'),
      cachedPath('g1/e1.png'),
    ]);
    expect(fs.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache empty successful responses', async () => {
    fs.fetch.mockResolvedValue({ ok: true, bytes: async () => new Uint8Array([]) });

    await expect(
      cacheImage('expense-attachments', 'g1/empty.png', 'https://signed.example/empty'),
    ).resolves.toBeNull();
    expect(
      cacheImageBytes('expense-attachments', 'g1/empty-local.png', new Uint8Array([])),
    ).toBeNull();
    expect(fs.files.has(cachedPath('g1/empty.png'))).toBe(false);
    expect(fs.files.has(cachedPath('g1/empty-local.png'))).toBe(false);
  });

  it('returns null and leaves no cache entry when download or atomic write fails', async () => {
    fs.fetch.mockResolvedValueOnce({ ok: false, bytes: async () => new Uint8Array([1]) });
    await expect(
      cacheImage('expense-attachments', 'g1/missing.png', 'https://signed.example/missing'),
    ).resolves.toBeNull();
    expect(fs.files.has(cachedPath('g1/missing.png'))).toBe(false);

    fs.fetch.mockResolvedValueOnce({ ok: true, bytes: async () => new Uint8Array([1]) });
    fs.failMove = true;
    await expect(
      cacheImage('expense-attachments', 'g1/broken.png', 'https://signed.example/broken'),
    ).resolves.toBeNull();
    expect(fs.files.has(cachedPath('g1/broken.png'))).toBe(false);
    expect([...fs.files.keys()].filter((key) => key.endsWith('.tmp'))).toEqual([]);
  });

  it('evicts cached bytes and swallows delete failures', () => {
    const uri = cacheImageBytes('expense-attachments', 'g1/e1.png', new Uint8Array([5]));
    expect(cachedImageUri('expense-attachments', 'g1/e1.png')).toBe(uri);

    evictImage('expense-attachments', 'g1/e1.png');
    expect(cachedImageUri('expense-attachments', 'g1/e1.png')).toBeNull();

    cacheImageBytes('expense-attachments', 'g1/e1.png', new Uint8Array([5]));
    fs.failDelete = true;
    expect(() => evictImage('expense-attachments', 'g1/e1.png')).not.toThrow();
    expect(() => evictImage('expense-attachments', null)).not.toThrow();
  });

  it('keeps the latest complete byte set when two writes target the same cache key', () => {
    fs.uuid.mockReturnValueOnce('first').mockReturnValueOnce('second');

    const first = cacheImageBytes('expense-attachments', 'g1/e1.png', new Uint8Array([1, 1]));
    const second = cacheImageBytes('expense-attachments', 'g1/e1.png', new Uint8Array([2, 2]));

    expect(second).toBe(first);
    expect(Array.from(fs.files.get(cachedPath('g1/e1.png')) ?? [])).toEqual([2, 2]);
    expect(
      [...fs.files.keys()].filter((key) => key.includes('.first') || key.includes('.second')),
    ).toEqual([]);
  });
});
