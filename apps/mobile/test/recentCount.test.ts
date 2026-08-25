import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RECENT_COUNT } from '@waves/core';

import { loadStoredRecentCount, saveStoredRecentCount } from '../src/lib/recentCount';

const KEY = 'recent.count';

describe('recent count storage', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await AsyncStorage.clear();
  });

  it('loads the default when storage is empty, invalid, or unavailable', async () => {
    await expect(loadStoredRecentCount()).resolves.toBe(DEFAULT_RECENT_COUNT);

    await AsyncStorage.setItem(KEY, '999');
    await expect(loadStoredRecentCount()).resolves.toBe(DEFAULT_RECENT_COUNT);

    vi.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(loadStoredRecentCount()).resolves.toBe(DEFAULT_RECENT_COUNT);
  });

  it('round-trips each allowed recent count through AsyncStorage', async () => {
    for (const count of [3, 5, 10] as const) {
      await saveStoredRecentCount(count);
      await expect(AsyncStorage.getItem(KEY)).resolves.toBe(String(count));
      await expect(loadStoredRecentCount()).resolves.toBe(count);
    }
  });

  it('swallows write failures after the caller has already updated UI state', async () => {
    vi.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));

    await expect(saveStoredRecentCount(10)).resolves.toBeUndefined();
  });

  it('keeps repeated preference loads cheap and deterministic', async () => {
    await AsyncStorage.setItem(KEY, '10');

    const values = await Promise.all(Array.from({ length: 200 }, () => loadStoredRecentCount()));

    expect(new Set(values)).toEqual(new Set([10]));
  });
});
