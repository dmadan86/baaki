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

    it(`${name} takes the status bar for as long as it is in front`, () => {
      const screen = source(path);
      // Running under the status bar means owning it: the root layout sets dark
      // glyphs under the light theme, which is unreadable on the wash.
      expect(screen).toMatch(/useHeroStatusBar\(\);/);
      // And it must be the focus-scoped hook, not a status bar mounted into the
      // tree — a tab screen stays mounted after you leave it, so that spelling
      // holds the bar light over the next white screen you walk to. Checked by
      // the import rather than by the element, so the prose in these files can
      // go on naming the thing it is explaining.
      expect(screen).not.toMatch(/from 'expo-status-bar'/);
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

describe("Review's list cells reserve their own spacing", () => {
  // FlashList measures a cell without its outer margins. A `marginTop` on the
  // root of a cell is therefore height the list does not know about, and it
  // draws the next cell over the top of it — which is what clipped the "READY
  // 134" heading in half, under the band above it. Padding is inside the
  // measured box and cannot do this.
  //
  // Cheap to state, and the trap is invisible in review: the code looks right,
  // and the bug only appears on a device with enough rows to scroll.
  const captures = source('app/(tabs)/captures.tsx');

  it('spaces every rendered item with padding, never margin', () => {
    const render = captures.match(/const renderItem = useCallback\([\s\S]*?\n {4}\[/);
    expect(render, 'captures should define renderItem').not.toBeNull();
    expect(render![0]).not.toMatch(/margin[A-Za-z]*:/);
  });

  it('spaces the pile heading with padding too', () => {
    // Bounded by the next declaration rather than by a closing brace: the
    // destructured parameter list closes at column nought too, so `\n}` ends
    // the match before the body it was meant to read.
    const heading = captures.match(/function SectionHeading\([\s\S]*?function DestinationChip/);
    expect(heading, 'captures should define SectionHeading').not.toBeNull();
    expect(heading![0]).not.toMatch(/margin[A-Za-z]*:/);
    expect(heading![0]).toMatch(/paddingTop:/);
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

  it('keeps the ticks when the confirm is answered "no"', () => {
    // The selection used to be cleared by the button, before the dialog had
    // even been drawn — so cancelling still cost a person every tick they had
    // made and left them to make them again. It is cleared inside, past the
    // point of no return, which is also past `guard.blockWrite()`.
    const body = captures.match(/const dismissMany = useCallback\([\s\S]*?\n {4}\[/);
    expect(body, 'captures should define dismissMany').not.toBeNull();
    expect(body![0]).toMatch(/if \(!ok\) return;[\s\S]*?setSelecting\(false\);/);

    const bulkButton = captures.match(
      /label=\{chosenRows\.every\(wasFound\)[\s\S]*?void dismissMany\(items\);[\s\S]*?\}\}/,
    );
    expect(bulkButton, 'captures should define the bulk dismissal button').not.toBeNull();
    expect(bulkButton![0]).not.toMatch(/setSelecting\(false\)|setSelected\(new Set\(\)\)/);
  });

  it('lets one refusal fail alone, and keeps its reason', () => {
    // Every other batch on this screen works this way: a draft the queue
    // refuses stays on the list rather than vanishing into a success message
    // that would be a lie.
    //
    // And the reason is kept. A bare `catch {}` counts the refusal and discards
    // the only thing that could explain it — which is how a failure on this
    // path reached a person as "try again in a moment" (a guess, and a wrong
    // one whenever the cause is permanent) and reached Sentry as nothing at
    // all. `catch {` with no binding is the shape that does that, so it is what
    // this forbids.
    const body = captures.match(/const dismissMany = useCallback\([\s\S]*?\n {4}\[/);
    expect(body![0]).toMatch(
      /for \(const item of items\) \{[\s\S]*?catch \(caught\) \{[\s\S]*?failed \+= 1;/,
    );
    expect(body![0]).toMatch(/firstError === undefined\) firstError = caught/);
    expect(body![0]).toMatch(/friendlyError\(firstError,/);
  });
});
