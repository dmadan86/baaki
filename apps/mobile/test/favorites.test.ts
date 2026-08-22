/**
 * Starring a group, and what the star survives.
 *
 * The favourites store is a device-local singleton the clone picker and the
 * group settings screen both read, so the behaviour worth pinning is the plain
 * arithmetic under the hook: a toggle flips membership, a re-toggle flips it
 * back, an empty id does nothing, subscribers hear every change, and — the one
 * that matters for a preference — a star written now is still there after a
 * cold reload from disk.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  __resetFavoritesForTest,
  isFavorite,
  loadFavorites,
  subscribeFavorites,
  toggleFavorite,
} from '../src/lib/favorites';

beforeEach(async () => {
  __resetFavoritesForTest();
  await AsyncStorage.clear();
});

describe('starring a group', () => {
  it('toggles a group in and back out', () => {
    expect(isFavorite('g1')).toBe(false);
    toggleFavorite('g1');
    expect(isFavorite('g1')).toBe(true);
    toggleFavorite('g1');
    expect(isFavorite('g1')).toBe(false);
  });

  it('keeps groups independent', () => {
    toggleFavorite('g1');
    expect(isFavorite('g1')).toBe(true);
    expect(isFavorite('g2')).toBe(false);
  });

  it('ignores an empty id', () => {
    toggleFavorite('');
    expect(isFavorite('')).toBe(false);
  });

  it('tells subscribers when a star changes', () => {
    const heard = vi.fn();
    const off = subscribeFavorites(heard);
    toggleFavorite('g1');
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    toggleFavorite('g2');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('survives a cold reload from disk', async () => {
    toggleFavorite('g1');
    // Simulate a fresh launch: the in-memory set is gone, only disk remains.
    __resetFavoritesForTest();
    expect(isFavorite('g1')).toBe(false);
    await loadFavorites();
    expect(isFavorite('g1')).toBe(true);
  });

  it('starts empty when disk holds nothing', async () => {
    await loadFavorites();
    expect(isFavorite('never-starred')).toBe(false);
  });
});
