/**
 * Where a selection is reported, and where it is acted on.
 *
 * Review and Bank messages are the two screens in this app where somebody ticks
 * a pile of rows and then does one thing to all of them, and both used to put
 * the same four kinds of control in one band at the bottom: how many are
 * ticked, "select all", the button that throws them away, and the buttons that
 * file them. Every list with a selection mode that is well made — Todoist,
 * Matter, GitHub, Quo, Yami — splits those in the same place instead. The count
 * and the scope control go to the header, because they are *state*; the bottom
 * bar keeps only *actions*, because that is the band a thumb is aiming at.
 *
 * Two things went wrong while they shared a band. "Select all" sat a few pixels
 * from "not an expense" — a scope control beside one that destroys work — and
 * the bar was two rows tall on a screen whose whole point is the list behind it.
 *
 * Source-reading, like `screenHeroShape.test.ts`, and for the same reason:
 * these screens pull in Reanimated and gesture-handler through their sheets and
 * cannot be mounted in this suite, but which half of the file a control is
 * written in is legible in the text.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../src');
const source = (relativePath: string): string => readFileSync(join(SRC, relativePath), 'utf8');

/** The hero half of a screen, and everything written after the panel closes. */
const halves = (screen: string): { hero: string; below: string } => {
  const end = screen.indexOf('</ScreenHero>');
  expect(end, 'the screen should render the shared hero').toBeGreaterThan(-1);
  return { hero: screen.slice(0, end), below: screen.slice(end) };
};

/**
 * The floating action bar itself — the absolutely-positioned panel that rises
 * over the list while rows are ticked, from its `position` to the view that
 * closes it. Sheets further down the file are not it: a picker restating "2
 * selected · ₹1,400" as it opens is a summary of what is about to happen, at
 * the moment somebody asked for it, and that is not the crowding this is about.
 */
const actionBar = (screen: string): string => {
  const { below } = halves(screen);
  const start = below.indexOf("position: 'absolute'");
  expect(start, 'the screen should raise an action bar over the list').toBeGreaterThan(-1);
  const end = below.indexOf('</View>', start);
  expect(end, 'the action bar should close').toBeGreaterThan(-1);
  return below.slice(start, end);
};

const SCREENS = [
  ['Review', 'app/(tabs)/captures.tsx'],
  ['Bank messages', 'app/captures/sms/index.tsx'],
] as const;

describe('a selection is reported on the panel, not in the action bar', () => {
  for (const [name, path] of SCREENS) {
    it(`${name} counts the ticked rows on the hero`, () => {
      const { hero } = halves(source(path));
      expect(hero).toMatch(/t\.smsInbox\.selected/);
    });

    it(`${name} does not repeat the count in the action bar`, () => {
      expect(actionBar(source(path))).not.toMatch(/t\.smsInbox\.selected\b/);
    });

    it(`${name} offers "select all" on the hero, in the on-panel button`, () => {
      const { hero } = halves(source(path));
      expect(hero).toMatch(/t\.smsInbox\.selectNone/);
      expect(hero).toMatch(/variant="onBrandOutline"/);
    });
  }
});

describe('the action bar holds actions, and the destructive one is set apart', () => {
  it('Review dismisses a selection with a glyph, not a third label on the line', () => {
    const bar = actionBar(source('app/(tabs)/captures.tsx'));
    // Three labelled buttons on one line truncate in Tamil and Arabic, and the
    // control that throws work away should not be a word-width target sitting
    // beside the one that files it.
    expect(bar).toMatch(/<IconButton[\s\S]*t\.captures\.notAnExpense/);
    expect(bar).not.toMatch(/variant="ghostDanger"/);
  });

  for (const [name, path, secondary] of [
    ['Review', 'app/(tabs)/captures.tsx', 't.voice.justMe'],
    ['Bank messages', 'app/captures/sms/index.tsx', 't.smsInbox.setAside'],
  ] as const) {
    it(`${name} gives both placements the same build`, () => {
      const below = actionBar(source(path));
      const escaped = secondary.replace(/\./g, '\\.');
      // A bare text link beside a filled pill reads as a footnote. Both of
      // these are places a draft can go, and neither is a footnote.
      const button = new RegExp(
        `label=\\{[^}]*${escaped}[^}]*\\}[\\s\\S]{0,200}?variant="([a-zA-Z]+)"`,
      );
      const match = below.match(button);
      expect(match, `${name} should still offer ${secondary}`).not.toBeNull();
      expect(match?.[1]).toBe('secondary');
    });
  }
});
