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

const aiSettings = vi.hoisted(() => ({ resetAiSettings: vi.fn(async () => undefined) }));
const aiEvents = vi.hoisted(() => ({ emitAiConfigChanged: vi.fn() }));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock-this-device-only',
  getItemAsync: secure.getItemAsync,
  setItemAsync: secure.setItemAsync,
  deleteItemAsync: secure.deleteItemAsync,
}));
vi.mock('@/lib/aiSettings', () => aiSettings);
vi.mock('@/lib/aiEvents', () => aiEvents);

const { configuredAiProviders, getActiveAiKey, getAiKey, removeAiKey, setActiveAiKey } =
  await import('../src/lib/aiKeys');

const STORE_KEY = 'baaki.aikey';

beforeEach(() => {
  secure.data.clear();
  secure.options.clear();
  secure.getItemAsync.mockClear();
  secure.setItemAsync.mockClear();
  secure.deleteItemAsync.mockClear();
  aiSettings.resetAiSettings.mockClear();
  aiEvents.emitAiConfigChanged.mockClear();
});

describe('AI key vault', () => {
  it('stores the active key trimmed with device-only SecureStore options', async () => {
    await setActiveAiKey('openai', '  sk-test  ');

    expect(JSON.parse(secure.data.get(STORE_KEY) ?? '{}')).toEqual({
      id: 'openai',
      key: 'sk-test',
    });
    expect(secure.options.get(STORE_KEY)).toEqual({
      keychainAccessible: 'after-first-unlock-this-device-only',
    });
    await expect(getActiveAiKey()).resolves.toEqual({ id: 'openai', key: 'sk-test' });
    expect(aiSettings.resetAiSettings).toHaveBeenCalledTimes(1);
    expect(aiEvents.emitAiConfigChanged).toHaveBeenCalledTimes(1);
  });

  it('ignores corrupt records and unknown providers', async () => {
    secure.data.set(STORE_KEY, '{not-json');
    await expect(getActiveAiKey()).resolves.toBeNull();

    secure.data.set(STORE_KEY, JSON.stringify({ id: 'unknown', key: 'sk-test' }));
    await expect(getActiveAiKey()).resolves.toBeNull();
    await expect(configuredAiProviders()).resolves.toEqual([]);
  });

  it('returns a key only for the connected provider', async () => {
    await setActiveAiKey('anthropic', 'sk-ant-test');

    await expect(getAiKey('anthropic')).resolves.toBe('sk-ant-test');
    await expect(getAiKey('openai')).resolves.toBeNull();
    await expect(configuredAiProviders()).resolves.toEqual(['anthropic']);
  });

  it('removes the active key and resets settings', async () => {
    await setActiveAiKey('moonshot', 'sk-test');
    aiSettings.resetAiSettings.mockClear();
    aiEvents.emitAiConfigChanged.mockClear();

    await removeAiKey();

    expect(secure.deleteItemAsync).toHaveBeenCalledWith(STORE_KEY);
    expect(secure.data.has(STORE_KEY)).toBe(false);
    expect(aiSettings.resetAiSettings).toHaveBeenCalledTimes(1);
    expect(aiEvents.emitAiConfigChanged).toHaveBeenCalledTimes(1);
  });
});
