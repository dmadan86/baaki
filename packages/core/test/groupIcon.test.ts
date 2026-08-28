/**
 * Guessing a group's icon from its name.
 *
 * This replaced a picker, so the bar is not "produces an emoji" — it is that
 * the name somebody actually types lands on the picture they would have chosen
 * themselves. The cases below are group names, not keywords, because a keyword
 * test only proves the table was typed correctly.
 */

import { describe, expect, it } from 'vitest';

import { GROUP_ICONS, guessGroupEmoji, guessGroupType } from '../src/index';

describe('a group name suggests a picture', () => {
  it('reads the ordinary names people give groups', () => {
    expect(guessGroupEmoji('Goa December')).toBe('🏖️');
    expect(guessGroupEmoji('Manali trek')).toBe('⛰️');
    expect(guessGroupEmoji('Flat 402')).toBe('🏠');
    expect(guessGroupEmoji('Priya wedding')).toBe('🎉');
    expect(guessGroupEmoji('Europe trip')).toBe('✈️');
    expect(guessGroupEmoji('Friday dinner')).toBe('🍽️');
    expect(guessGroupEmoji('College batch')).toBe('🎓');
    expect(guessGroupEmoji('Office offsite')).toBe('🏢');
  });

  it('lets the specific beat the general', () => {
    // Both words are in the table. A beach is a better picture of this group
    // than an aeroplane, and it is the one listed first.
    expect(guessGroupEmoji('Goa trip')).toBe('🏖️');
    expect(guessGroupEmoji('Ladakh road trip')).toBe('⛰️');
    // Nothing more specific to lose to, so the general one still answers.
    expect(guessGroupEmoji('Work trip')).toBe('🏢');
  });

  it('says nothing rather than guessing', () => {
    // Null is not "other". The caller knows which kind of group was picked and
    // has a better answer than this file could invent.
    expect(guessGroupEmoji('')).toBeNull();
    expect(guessGroupEmoji('   ')).toBeNull();
    expect(guessGroupEmoji('Ravi and Asha')).toBeNull();
    expect(guessGroupEmoji('Group 3')).toBeNull();
  });

  it('matches whole words, never fragments', () => {
    // The bug this rule exists for: `ola` is a cab company and also the middle
    // of "chocolate", `pg` is a flatshare and also the middle of nothing good.
    expect(guessGroupEmoji('Chocolate fund')).toBeNull();
    expect(guessGroupEmoji('Carnival')).toBeNull();
    expect(guessGroupEmoji('Ola rides')).toBe('🚗');
  });

  it('survives a name that is not in Latin script', () => {
    // Tamil and Hindi names must not be shredded into single characters by the
    // tokeniser — they should fall through to null, not to a wrong picture.
    expect(guessGroupEmoji('வீட்டு செலவு')).toBeNull();
    expect(guessGroupEmoji('घर का खर्च')).toBeNull();
    // A mixed name still finds the word it does know.
    expect(guessGroupEmoji('கோவா trip')).toBe('✈️');
  });

  it('ignores case and punctuation', () => {
    expect(guessGroupEmoji('GOA!!')).toBe('🏖️');
    expect(guessGroupEmoji('flat-402')).toBe('🏠');
    expect(guessGroupEmoji('  Wedding  ')).toBe('🎉');
  });
});

describe('a group name suggests a kind', () => {
  it('catches the names that really are a trip', () => {
    expect(guessGroupType('Goa December')).toBe('trip');
    expect(guessGroupType('Manali trek')).toBe('trip');
    expect(guessGroupType('Europe trip')).toBe('trip');
  });

  it('reads the non-trip kinds too', () => {
    expect(guessGroupType('Flat 402')).toBe('home');
    expect(guessGroupType('Grocery run')).toBe('home');
    expect(guessGroupType('Priya wedding')).toBe('event');
    expect(guessGroupType('Honeymoon')).toBe('couple');
    expect(guessGroupType('Friday dinner')).toBe('friends');
    expect(guessGroupType('Office offsite')).toBe('other');
  });

  it('says nothing when the name says nothing, so the caller keeps its default', () => {
    // The screen opens on Other, not Trip — null here is what lets a bare name
    // stay Other instead of dragging trip fields in.
    expect(guessGroupType('')).toBeNull();
    expect(guessGroupType('Ravi and Asha')).toBeNull();
    expect(guessGroupType('Group 3')).toBeNull();
  });

  it('maps every icon in the table to a kind', () => {
    // A picture with no kind would silently fall through to the caller's
    // default even when the name clearly meant something.
    for (const icon of GROUP_ICONS) {
      const name = `test ${icon.keywords[0]}`;
      expect(
        guessGroupType(name),
        `${icon.emoji} (${icon.keywords[0]}) has no kind`,
      ).not.toBeNull();
    }
  });
});

describe('the icon table', () => {
  it('never gives one word to two icons', () => {
    // A word in two lists makes the answer depend on table order rather than on
    // meaning, which is how a rename quietly changes what people see.
    const seen = new Map<string, string>();
    for (const icon of GROUP_ICONS) {
      for (const keyword of icon.keywords) {
        expect(seen.has(keyword), `${keyword} is in ${seen.get(keyword)} and ${icon.emoji}`).toBe(
          false,
        );
        seen.set(keyword, icon.emoji);
      }
    }
  });

  it('holds only lowercase single words', () => {
    for (const icon of GROUP_ICONS) {
      for (const keyword of icon.keywords) {
        expect(keyword).toBe(keyword.toLowerCase());
        expect(keyword).not.toMatch(/\s/);
      }
    }
  });
});
