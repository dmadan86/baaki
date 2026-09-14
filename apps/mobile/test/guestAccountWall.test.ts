/**
 * The two rooms a guest account may not enter, and every door to them.
 *
 * A guest session is a real anonymous account — it can start a group, add
 * expenses, settle up — and the ceilings on it (`lib/guestGuard`) are about how
 * *much*. The private ledger and the bank-message reader are a different rule
 * and a harder one: both keep their value under an identity a guest has no way
 * back into, so both ask for an email or a phone before they open at all.
 *
 * A rule like that is only worth as much as its least-guarded door, and there
 * are more doors than there are screens: a tab, a pushed screen, a deep link
 * into one message, a "Just me" chip on three different sheets. This suite
 * walks all of them. It reads source rather than rendering, like
 * `screenHeroShape` and `captureGroupHandoff`, because these screens pull in
 * Reanimated and gesture-handler through their sheets and this suite runs in
 * node — but "does this door ask" is legible in the text.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../src');
const source = (relativePath: string): string => readFileSync(join(SRC, relativePath), 'utf8');

describe('the private ledger asks for an account', () => {
  it('turns a guest away before the biometric prompt is ever raised', () => {
    const guard = source('components/PersonalGuard.tsx');
    // The wall, and the gate one component below it. Both matter: a guest sent
    // to the wall by a component that had already called `usePersonalGate`
    // would have been asked for a fingerprint on the way out.
    expect(guard).toMatch(/if \(isGuest\) return <SignInWall area="personal" \/>;/);
    expect(guard).toMatch(/function PersonalUnlock\(/);
    const outer = guard.slice(
      guard.indexOf('export function PersonalGuard('),
      guard.indexOf('function PersonalUnlock('),
    );
    expect(outer).not.toMatch(/usePersonalGate/);
  });

  it('walls the Me tab outside the ledger, not inside it', () => {
    const me = source('app/(tabs)/me.tsx');
    expect(me).toMatch(/if \(isGuest\) return <SignInWall area="personal" \/>;/);
    // The body is a second component, so a guest mounts none of it: no mirror
    // read, no month, no prompt.
    expect(me).toMatch(/function MeLedger\(\)/);
    const outer = me.slice(
      me.indexOf('export default function MeScreen()'),
      me.indexOf('function MeLedger()'),
    );
    expect(outer).not.toMatch(/usePersonalGate|usePersonalLedger/);
  });

  it('keeps "Just me" off every sheet that offers a destination', () => {
    // One switch, three doors. `usePersonalOffered` is the switch; a door that
    // named `isGuest` itself would be a fourth opinion about the same rule.
    for (const path of [
      'components/DestinationPicker.tsx',
      'app/(tabs)/captures.tsx',
      'app/capture.tsx',
    ]) {
      const screen = source(path);
      expect(screen).toMatch(/usePersonalOffered/);
      expect(screen).toMatch(/personalOffered/);
    }
  });
});

describe('bank messages ask for an account', () => {
  it('makes the account part of the reader gate rather than of each screen', () => {
    const feature = source('lib/smsFeature.ts');
    // Both readers, so the background job stops as well as the buttons: a guest
    // whose inbox was being read hourly into a ledger they could not keep would
    // be the worst of both answers.
    expect(feature).toMatch(/variant === TREATMENT && !isGuest/);
    expect(feature).toMatch(/if \(isGuest\) return 'off';/);
  });

  it('gives a guest a reason on every screen behind it, never a blank one', () => {
    for (const path of ['app/captures/sms/index.tsx', 'app/captures/sms/[key].tsx']) {
      const screen = source(path);
      const wall = screen.indexOf('if (isGuest) return <SignInWall area="sms" />;');
      const blank = screen.indexOf('if (!reader) return null;');
      expect(wall).toBeGreaterThan(-1);
      // Order is the whole point: `useSmsInboxReader` is false for a guest too,
      // so whichever of these comes first decides whether they are told why.
      expect(wall).toBeLessThan(blank);
    }
  });

  it('walls pasting as well, which is the same feature on an iPhone', () => {
    const paste = source('app/captures/paste.tsx');
    expect(paste).toMatch(/if \(isGuest\) return <SignInWall area="sms" \/>;/);
  });
});

describe('the wall itself', () => {
  const wall = source('components/SignInWall.tsx');

  it('offers linking, not signing in as somebody else', () => {
    // From a guest session, signing in is a swap rather than an upgrade: the
    // groups made this afternoon would be left behind an account with no
    // address. `/settings/account` links an email or a phone to *this* session.
    expect(wall).toMatch(/router\.push\('\/settings\/account'\)/);
    expect(wall).not.toMatch(/'\/sign-in'|'\/sign-up'/);
  });

  it('says why in the language the app is in', () => {
    expect(wall).toMatch(/t\.signInWall\.title/);
    expect(wall).toMatch(/t\.signInWall\.personalBody/);
    expect(wall).toMatch(/t\.signInWall\.smsBody/);
    expect(wall).not.toMatch(/"[A-Z][a-z]+ [a-z ]+"/);
  });
});
