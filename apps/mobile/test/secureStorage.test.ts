import { beforeEach, describe, expect, it, vi } from 'vitest';

const secure = vi.hoisted(() => ({
  data: new Map<string, string>(),
  options: new Map<string, unknown>(),
  getItemAsync: vi.fn(async (key: string) => secure.data.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string, options?: unknown) => {
    secure.data.set(key, value);
    secure.options.set(key, options);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secure.data.delete(key);
  }),
}));

const asyncStorage = vi.hoisted(() => ({
  data: new Map<string, string>(),
  getItem: vi.fn(async (key: string) => asyncStorage.data.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => {
    asyncStorage.data.set(key, value);
  }),
  removeItem: vi.fn(async (key: string) => {
    asyncStorage.data.delete(key);
  }),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock-this-device-only',
  getItemAsync: secure.getItemAsync,
  setItemAsync: secure.setItemAsync,
  deleteItemAsync: secure.deleteItemAsync,
}));

const { secureAuthStorage } = await import('../src/lib/secureStorage');

beforeEach(() => {
  secure.data.clear();
  secure.options.clear();
  secure.getItemAsync.mockClear();
  secure.setItemAsync.mockClear();
  secure.deleteItemAsync.mockClear();
  asyncStorage.data.clear();
  asyncStorage.getItem.mockClear();
  asyncStorage.setItem.mockClear();
  asyncStorage.removeItem.mockClear();
});

describe('secureAuthStorage', () => {
  it('chunks large sessions into device-only SecureStore entries', async () => {
    const value = 'x'.repeat(4000);

    await secureAuthStorage.setItem('supabase.auth.token', value);

    expect(secure.data.get('supabase.auth.token.pn')).toBe('3');
    expect(secure.data.get('supabase.auth.token.p0')).toHaveLength(1800);
    expect(secure.data.get('supabase.auth.token.p1')).toHaveLength(1800);
    expect(secure.data.get('supabase.auth.token.p2')).toHaveLength(400);
    expect(secure.options.get('supabase.auth.token.p0')).toEqual({
      keychainAccessible: 'after-first-unlock-this-device-only',
    });
    await expect(secureAuthStorage.getItem('supabase.auth.token')).resolves.toBe(value);
  });

  it('removes orphan chunks when a later session is shorter', async () => {
    await secureAuthStorage.setItem('session', 'x'.repeat(4000));
    await secureAuthStorage.setItem('session', 'short');

    expect(secure.data.get('session.pn')).toBe('1');
    expect(secure.data.get('session.p0')).toBe('short');
    expect(secure.data.has('session.p1')).toBe(false);
    expect(secure.data.has('session.p2')).toBe(false);
  });

  it('treats a torn chunk write as no session', async () => {
    secure.data.set('session.pn', '2');
    secure.data.set('session.p0', 'first');

    await expect(secureAuthStorage.getItem('session')).resolves.toBeNull();
  });

  it('migrates legacy AsyncStorage session and retries plaintext cleanup', async () => {
    asyncStorage.data.set('session', 'legacy');
    asyncStorage.removeItem.mockRejectedValueOnce(new Error('remove failed'));

    await expect(secureAuthStorage.getItem('session')).resolves.toBe('legacy');
    expect(asyncStorage.data.get('session')).toBe('legacy');

    await expect(secureAuthStorage.getItem('session')).resolves.toBe('legacy');
    expect(asyncStorage.data.has('session')).toBe(false);
  });

  it('removes every secure chunk and the count marker', async () => {
    await secureAuthStorage.setItem('session', 'x'.repeat(4000));

    await secureAuthStorage.removeItem('session');

    expect(secure.data.has('session.pn')).toBe(false);
    expect(secure.data.has('session.p0')).toBe(false);
    expect(secure.data.has('session.p1')).toBe(false);
    expect(secure.data.has('session.p2')).toBe(false);
  });
});
