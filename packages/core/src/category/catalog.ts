/**
 * The user's expense-tag catalog — built-ins plus the tags they define
 * themselves (extends TDR §8).
 *
 * A category used to be one of ten fixed built-ins. Now a person can add their
 * own tags (a label, an icon, a colour), and hide or reorder the built-ins. That
 * personal catalog lives in the `category_tags` table (one row per custom tag,
 * plus one override row per built-in the person has hidden or moved). This module
 * turns those rows — together with the fixed `CATEGORIES` — into the single
 * ordered list the pickers and the manager render, and resolves a stored category
 * value (built-in id or custom tag id) to something drawable.
 *
 * Pure and React-free, like the rest of `@waves/core`: the mobile layer supplies
 * the translated built-in labels; everything else is decided here so the picker,
 * the badges and the insights charts agree.
 */

import { CATEGORIES, categoryOf, CategoryId, OTHER } from './categories';

/** The design system's six pastel tints, mirrored here so core need not depend on
 *  the UI package. Keep in step with `tints` in `@waves/ui`. */
export const TINTS = ['lilac', 'pink', 'mint', 'peach', 'sky', 'coral'] as const;
export type TintName = (typeof TINTS)[number];

/** Anything not one of the six falls back rather than rendering an undefined
 *  tint — a custom tag's stored colour is free text until it reaches here. */
export function normaliseTint(value: string | null | undefined): TintName {
  return (TINTS as readonly string[]).includes(value ?? '') ? (value as TintName) : 'sky';
}

/**
 * The denormalised display of a custom tag, snapshotted onto an expense version
 * or capture so a viewer without the author's catalog still renders it. Null on
 * the row for a built-in, which resolves from `CATEGORIES` instead.
 */
export interface CategoryMeta {
  readonly label: string;
  readonly icon: string;
  readonly tint: TintName;
}

/** One row of the per-user catalog (`category_tags`), in app-facing camelCase. */
export interface CategoryTagRow {
  readonly id: string;
  /** Set → this row overrides a built-in (its id, e.g. 'food'); null → a custom tag. */
  readonly builtinId: string | null;
  readonly label: string | null;
  readonly icon: string | null;
  readonly tint: string | null;
  readonly sortOrder: number;
  readonly hidden: boolean;
}

/** A category resolved for rendering — enough to draw a badge and label it. */
export interface ResolvedCategory {
  /** The value stored on the expense/capture (`food`… or a custom tag uuid). */
  readonly key: string;
  readonly icon: string;
  readonly tint: TintName;
  /** English default for built-ins (translate via `t.categories`); the tag's own
   *  label for a custom. */
  readonly label: string;
  readonly custom: boolean;
  /** The built-in this resolves to, or null for a custom tag. */
  readonly builtinId: CategoryId | null;
}

/** An entry in the effective, ordered catalog the pickers and manager show. */
export interface CatalogEntry {
  readonly key: string;
  readonly icon: string;
  readonly tint: TintName;
  readonly label: string;
  readonly custom: boolean;
  readonly builtinId: CategoryId | null;
  readonly hidden: boolean;
  readonly sortOrder: number;
  /** The `category_tags` row backing this entry — the id to edit/delete a custom
   *  tag, or the override row of a built-in. Null when a built-in has no override
   *  yet (the manager creates one lazily on first hide/reorder). */
  readonly tagId: string | null;
}

/** Built-ins keep their declared order until the person reorders them. */
const BUILTIN_ORDER = new Map<string, number>(CATEGORIES.map((c, index) => [c.id, index]));

/**
 * Resolve a stored category value to something drawable.
 *
 * A custom tag always travels with its `meta` snapshot, so that wins when
 * present; otherwise the value is a built-in id (or unknown, which `categoryOf`
 * folds to "Other"). The caller translates a built-in's label through its own
 * string table; the English default is returned so a labelless caller still has
 * something.
 */
export function resolveCategory(
  key: string | null | undefined,
  meta?: CategoryMeta | null,
): ResolvedCategory {
  if (meta) {
    return {
      key: key ?? '',
      icon: meta.icon,
      tint: normaliseTint(meta.tint),
      label: meta.label,
      custom: true,
      builtinId: null,
    };
  }
  const builtin = categoryOf(key);
  return {
    key: builtin.id,
    icon: builtin.icon,
    tint: builtin.tint,
    label: builtin.label,
    custom: false,
    builtinId: builtin.id,
  };
}

/**
 * The effective catalog: the fixed built-ins merged with the person's override
 * rows (hidden / reordered), plus their custom tags, in one order.
 *
 * `labelForBuiltin` lets the mobile layer supply translated built-in labels;
 * omitted, the English defaults from `CATEGORIES` are used. Custom labels are the
 * user's own text and are never translated.
 *
 * Returns `all` (for the manager, hidden included) and `visible` (for the
 * pickers, hidden dropped), both ordered by `sortOrder` with a stable tiebreak so
 * the list never jitters between renders.
 */
export function buildCatalog(
  rows: readonly CategoryTagRow[],
  labelForBuiltin?: (id: CategoryId) => string,
): { all: readonly CatalogEntry[]; visible: readonly CatalogEntry[] } {
  const overrides = new Map<string, CategoryTagRow>();
  const customs: CategoryTagRow[] = [];
  for (const row of rows) {
    if (row.builtinId) overrides.set(row.builtinId, row);
    else customs.push(row);
  }

  const builtinEntries: CatalogEntry[] = CATEGORIES.map((category, index) => {
    const override = overrides.get(category.id);
    return {
      key: category.id,
      icon: category.icon,
      tint: category.tint,
      label: labelForBuiltin ? labelForBuiltin(category.id) : category.label,
      custom: false,
      builtinId: category.id,
      hidden: override?.hidden ?? false,
      sortOrder: override?.sortOrder ?? index,
      tagId: override?.id ?? null,
    };
  });

  const customEntries: CatalogEntry[] = customs.map((row) => ({
    key: row.id,
    icon: row.icon ?? OTHER.icon,
    tint: normaliseTint(row.tint),
    label: row.label ?? '',
    custom: true,
    builtinId: null,
    hidden: row.hidden,
    sortOrder: row.sortOrder,
    tagId: row.id,
  }));

  const all = [...builtinEntries, ...customEntries].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    // Stable tiebreak: built-ins in their declared order, then customs by key.
    const ai = BUILTIN_ORDER.get(a.key) ?? Number.MAX_SAFE_INTEGER;
    const bi = BUILTIN_ORDER.get(b.key) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return { all, visible: all.filter((entry) => !entry.hidden) };
}

/** The sort_order a newly created tag should take: after everything already
 *  there, so a new tag lands at the end rather than jumping to the top (custom
 *  rows default to 0 in the DB). */
export function nextSortOrder(rows: readonly CategoryTagRow[]): number {
  const max = rows.reduce((m, row) => Math.max(m, row.sortOrder), CATEGORIES.length - 1);
  return max + 1;
}
