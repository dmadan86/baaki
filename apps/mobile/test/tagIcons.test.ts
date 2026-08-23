/**
 * The custom-tag icon set.
 *
 * Its names are validated at compile time — the arrays are typed
 * `keyof typeof Ionicons.glyphMap`, so a typo'd glyph is a build error, not a
 * blank square on a device. What a build cannot catch, and these do: a duplicate
 * that would render the same glyph twice in the picker, a set that has quietly
 * shrunk, and a default that is not actually in the set the picker shows.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_TAG_ICON, TAG_ICON_GROUPS, TAG_ICONS } from '@/components/tagIcons';

describe('tag icons', () => {
  it('is the flattened groups, in order', () => {
    expect(TAG_ICONS).toEqual(TAG_ICON_GROUPS.flat());
  });

  it('has no duplicate glyph across the whole set', () => {
    expect(new Set(TAG_ICONS).size).toBe(TAG_ICONS.length);
  });

  it('offers a wide choice', () => {
    // A guard against an accidental deletion shrinking the set back to a handful.
    expect(TAG_ICONS.length).toBeGreaterThanOrEqual(80);
  });

  it('every glyph is an outline style, to sit with the built-ins', () => {
    for (const glyph of TAG_ICONS) expect(glyph.endsWith('-outline')).toBe(true);
  });

  it('the default is one of the icons the picker shows', () => {
    expect(TAG_ICONS).toContain(DEFAULT_TAG_ICON);
  });

  it('groups are non-empty', () => {
    for (const group of TAG_ICON_GROUPS) expect(group.length).toBeGreaterThan(0);
  });
});
