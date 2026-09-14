/**
 * One hero, not four.
 *
 * The gradient panel that a group opens with — running up under the status bar,
 * carrying the name of the thing, one number that is the point of the screen,
 * and the actions that number invites — is now also what Review and Bank
 * messages open with. It is a *shared shell* (`components/ScreenHero`), and the
 * only way it stays shared is if nobody quietly hand-rolls a fifth copy the
 * next time a screen wants one: four `Gradient` panels with four sets of
 * padding drift within a release, and then the app has four ideas about how
 * tall a header is.
 *
 * Source-reading, like `captureGroupHandoff.test.ts` and `captureFactsCard`:
 * these screens pull in Reanimated and gesture-handler by way of their sheets,
 * which this node-environment suite cannot mount, but "which component draws
 * the header" is legible in the text without any of that.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../src');
const source = (relativePath: string): string => readFileSync(join(SRC, relativePath), 'utf8');

describe('every hero is the same hero', () => {
  for (const [name, path] of [
    ['Review', 'app/(tabs)/captures.tsx'],
    ['Bank messages', 'app/captures/sms/index.tsx'],
  ] as const) {
    it(`${name} opens on the shared panel, not a panel of its own`, () => {
      const screen = source(path);
      expect(screen).toMatch(/import \{[^}]*ScreenHero[^}]*\} from '@\/components\/ScreenHero';/);
      expect(screen).toMatch(/<ScreenHero\b/);
      // A `Gradient` of its own would be the beginning of a second hero. The
      // shell owns the wash, the inset and the rounded bottom; a screen that
      // needs a different one passes stops, it does not draw its own panel.
      expect(screen).not.toMatch(/<Gradient\b/);
    });

    it(`${name} lets the panel run under the status bar`, () => {
      // `edges={['top']}` would inset the screen and leave a band of body
      // colour above the gradient — the bug that makes a hero look pasted on.
      expect(source(path)).toMatch(/<Screen edges=\{\[\]\}>/);
    });
  }

  it('the group hero uses the shared controls rather than its own copies', () => {
    const hero = source('components/GroupHero.tsx');
    expect(hero).toMatch(
      /import \{ HeroActionCircle, HeroPillButton \} from '@\/components\/ScreenHero';/,
    );
    // The white pill and the dim disc were defined here and are now shared. A
    // local `function HeroActionCircle` reappearing means somebody has forked
    // them back apart.
    expect(hero).not.toMatch(/function Hero(ActionCircle|PillButton)\b/);
  });
});

describe('review can answer "not an expense" about a whole pile', () => {
  const captures = source('app/(tabs)/captures.tsx');

  it('has a bulk dismissal wired to the selection bar', () => {
    expect(captures).toMatch(/const dismissMany = useCallback\(/);
    expect(captures).toMatch(/void dismissMany\(items\)/);
  });

  it('asks once, and only when a person made one of the drafts', () => {
    // The same rule the single-row `dismiss` follows, applied to the pile: a
    // draft the app found costs nothing to drop (the message is still in the
    // phone's own Messages app), and a dialog in front of a loss-free action is
    // a dialog people learn to dismiss unread. The moment one draft carries
    // somebody's own words or a photograph of a bill, the confirm comes back —
    // once, for the lot.
    const body = captures.match(/const dismissMany = useCallback\([\s\S]*?\n {4}\[/);
    expect(body, 'captures should define dismissMany').not.toBeNull();
    expect(body![0]).toMatch(/const allFound = items\.every\(wasFound\)/);
    expect(body![0]).toMatch(/if \(!allFound\) \{[\s\S]*?await confirm\(\{/);
  });

  it('keeps a mixed user, rider, traveller and financer selection if the delete is cancelled', () => {
    const body = captures.match(/const dismissMany = useCallback\([\s\S]*?\n {4}\[/);
    expect(body, 'captures should define dismissMany').not.toBeNull();
    expect(body![0]).toMatch(/if \(!ok\) return;[\s\S]*?setSelecting\(false\);/);

    const bulkButton = captures.match(
      /label=\{chosenRows\.every\(wasFound\)[\s\S]*?void dismissMany\(items\);[\s\S]*?\}\}/,
    );
    expect(bulkButton, 'captures should define the bulk dismissal button').not.toBeNull();
    expect(bulkButton![0]).not.toMatch(/setSelecting\(false\)|setSelected\(new Set\(\)\)/);
  });

  it('lets one refusal fail alone', () => {
    // Every other batch on this screen works this way: a draft the queue
    // refuses stays on the list rather than vanishing into a success message
    // that would be a lie.
    const body = captures.match(/const dismissMany = useCallback\([\s\S]*?\n {4}\[/);
    expect(body![0]).toMatch(/for \(const item of items\) \{[\s\S]*?catch \{[\s\S]*?failed \+= 1;/);
  });
});
