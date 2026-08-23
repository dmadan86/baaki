/**
 * The catalog merges a fixed set of built-ins with a person's own rows — custom
 * tags, and overrides that hide or reorder the built-ins. The invariants that
 * matter: a custom tag renders from its own snapshot, a built-in still resolves
 * without one, hidden entries leave the pickers but not the manager, and the
 * order the person set is the order everyone reads.
 */

import { describe, expect, it } from 'vitest';

import {
  buildCatalog,
  nextSortOrder,
  resolveCategory,
  type CategoryTagRow,
  type TintName,
} from '../src/category/catalog.js';
import { CATEGORIES } from '../src/category/categories.js';

const custom = (over: Partial<CategoryTagRow> & { id: string }): CategoryTagRow => ({
  builtinId: null,
  label: 'Client dinner',
  icon: 'briefcase-outline',
  tint: 'mint',
  sortOrder: 100,
  hidden: false,
  ...over,
});

describe('resolveCategory', () => {
  it('renders a custom tag from its denormalised snapshot', () => {
    const resolved = resolveCategory('tag-uuid', {
      label: 'Client dinner',
      icon: 'briefcase-outline',
      tint: 'mint',
    });
    expect(resolved.custom).toBe(true);
    expect(resolved.label).toBe('Client dinner');
    expect(resolved.icon).toBe('briefcase-outline');
    expect(resolved.tint).toBe('mint');
    expect(resolved.builtinId).toBeNull();
  });

  it('resolves a built-in from its id, no snapshot needed', () => {
    const resolved = resolveCategory('food');
    expect(resolved.custom).toBe(false);
    expect(resolved.builtinId).toBe('food');
    expect(resolved.icon).toBe(CATEGORIES.find((c) => c.id === 'food')!.icon);
  });

  it('folds an unknown key with no snapshot to Other, never throws', () => {
    expect(resolveCategory('some-deleted-tag').builtinId).toBe('other');
    expect(resolveCategory(null).builtinId).toBe('other');
  });

  it('coerces an unknown tint rather than trusting the payload', () => {
    const resolved = resolveCategory('x', {
      label: 'X',
      icon: 'star',
      tint: 'chartreuse' as TintName,
    });
    expect(resolved.tint).toBe('sky');
  });
});

describe('buildCatalog', () => {
  it('shows every built-in plus custom tags when the catalog is empty', () => {
    const { visible, all } = buildCatalog([]);
    expect(all).toHaveLength(CATEGORIES.length);
    expect(visible).toHaveLength(CATEGORIES.length);
    // Built-ins keep their declared order.
    expect(visible.map((e) => e.key)).toEqual(CATEGORIES.map((c) => c.id));
  });

  it('appends a custom tag after the built-ins', () => {
    const { visible } = buildCatalog([custom({ id: 't1', sortOrder: nextSortOrder([]) })]);
    expect(visible).toHaveLength(CATEGORIES.length + 1);
    expect(visible[visible.length - 1]!.key).toBe('t1');
    expect(visible[visible.length - 1]!.custom).toBe(true);
  });

  it('drops a hidden built-in from the pickers but keeps it in the manager', () => {
    const override: CategoryTagRow = {
      id: 'o1',
      builtinId: 'gifts',
      label: null,
      icon: null,
      tint: null,
      sortOrder: 5,
      hidden: true,
    };
    const { visible, all } = buildCatalog([override]);
    expect(visible.find((e) => e.key === 'gifts')).toBeUndefined();
    expect(all.find((e) => e.key === 'gifts')?.hidden).toBe(true);
  });

  it('honours an override that reorders a built-in to the front', () => {
    const override: CategoryTagRow = {
      id: 'o1',
      builtinId: 'gifts',
      label: null,
      icon: null,
      tint: null,
      sortOrder: -1,
      hidden: false,
    };
    const { visible } = buildCatalog([override]);
    expect(visible[0]!.key).toBe('gifts');
  });

  it('translates built-in labels through the supplied resolver, never customs', () => {
    const { visible } = buildCatalog(
      [custom({ id: 't1', label: 'Client dinner' })],
      (id) => `L:${id}`,
    );
    expect(visible.find((e) => e.key === 'food')!.label).toBe('L:food');
    expect(visible.find((e) => e.key === 't1')!.label).toBe('Client dinner');
  });
});
