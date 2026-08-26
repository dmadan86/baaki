import { beforeEach, describe, expect, it, vi } from 'vitest';

const sharing = vi.hoisted(() => ({
  available: true,
  share: vi.fn(async () => undefined),
}));

const fs = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  failDelete: false,
}));

class FakeFile {
  readonly uri: string;

  constructor(...parts: string[]) {
    this.uri = parts.join('/');
  }

  get exists(): boolean {
    return fs.files.has(this.uri);
  }

  create(): void {
    fs.files.set(this.uri, new Uint8Array());
  }

  write(bytes: Uint8Array): void {
    fs.files.set(this.uri, new Uint8Array(bytes));
  }

  delete(): void {
    if (fs.failDelete) throw new Error('delete failed');
    fs.files.delete(this.uri);
  }
}

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(async () => sharing.available),
  shareAsync: sharing.share,
}));

vi.mock('expo-file-system', () => ({
  File: FakeFile,
  Paths: { cache: 'cache-root' },
}));

const { saveImageToDevice } = await import('../src/lib/saveImage');

beforeEach(() => {
  fs.files.clear();
  fs.failDelete = false;
  sharing.available = true;
  sharing.share.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })),
  );
});

describe('saveImageToDevice', () => {
  it('deletes the temporary receipt file after the share sheet returns', async () => {
    await expect(saveImageToDevice('https://signed.example/receipt')).resolves.toBe('shared');

    expect(sharing.share).toHaveBeenCalledWith('cache-root/receipt.png', {
      mimeType: 'image/png',
      dialogTitle: 'Save receipt',
    });
    expect(fs.files.has('cache-root/receipt.png')).toBe(false);
  });

  it('still reports shared when best-effort temp cleanup fails', async () => {
    fs.failDelete = true;

    await expect(saveImageToDevice('https://signed.example/receipt')).resolves.toBe('shared');
    expect(fs.files.has('cache-root/receipt.png')).toBe(true);
  });

  it('deletes the temp file when sharing throws, then returns error', async () => {
    sharing.share.mockRejectedValueOnce(new Error('share failed'));

    await expect(saveImageToDevice('https://signed.example/receipt')).resolves.toBe('error');
    expect(fs.files.has('cache-root/receipt.png')).toBe(false);
  });
});
