/**
 * Capture never grows a payer or a split of its own — those live on
 * add-expense, because they describe how a bill is shared among a group's
 * members, and a capture's whole reason to exist is that there may be no
 * group yet (A34). Picking a real group in the destination sheet instead
 * hands the draft straight to that group's add-expense form (the same
 * hand-off the inbox already uses to assign a capture — `captureAssign.ts`),
 * so who paid and how it's split are asked there, once, in their one honest
 * place.
 *
 * Source-reading, like `captureFactsCard.test.ts`: the screen pulls in
 * Reanimated and gesture-handler by way of `SheetOverlay`, which this
 * node-environment suite cannot mount, but the shape worth protecting — that
 * a real group always leaves this screen for add-expense — is legible in the
 * text without any of that. The exact fields the hand-off carries are covered
 * at the unit level in `captureAssign.test.ts` (`captureDraftFields` +
 * `assignCaptureHref`).
 *
 * Two answers now stay here rather than one. "Just me" joined "decide later"
 * on the near side of that line, and it belongs there: a spend split with
 * nobody has no payer to name and no split to describe, so there is nothing
 * for add-expense to ask. It is not an exception to the rule above — it is the
 * rule, which is about *sharing*, meeting a spend that is not shared.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../src');
const source = (relativePath: string): string => readFileSync(join(SRC, relativePath), 'utf8');

describe('capture never asks who paid or how it is split itself', () => {
  const capture = source('app/capture.tsx');

  it('imports no payer or split control — those are add-expense-only', () => {
    // The vocabulary add-expense's own facts card and payer chooser use. None
    // of it belongs on this screen: a payer or a split control here, even
    // hidden behind a group check, would be a place to reimplement the split
    // engine rather than reuse it (packages/core), which the task guarding
    // this file forbids outright.
    expect(capture).not.toMatch(/payerChoices|PayerRow|SplitEntries|splitParams|computeShares/);
  });

  it('keeps the facts card to exactly what-for, paid-with, destination and date', () => {
    const match = capture.match(/<DetailRows>([\s\S]*?)<\/DetailRows>/);
    expect(match, 'capture should render exactly one DetailRows block').not.toBeNull();
    const block = match![1]!;
    // Four rows, not six: no fifth "who paid" or sixth "split" row ever joins
    // this block, whatever the destination row currently reads.
    const rows = block.match(/<(CategoryRow|PaymentMethodRow|DetailRow)\b/g) ?? [];
    expect(rows).toHaveLength(4);
  });

  it('hands off to add-expense, not to itself, the moment a real group is picked', () => {
    // GroupPicker's onPick has three branches. Two record a choice and stay
    // here — "decide later", and "just me", which has no payer to name and no
    // split to describe. The third pushes to the group's own add-expense form
    // via the exact builder the inbox's assign already uses, so the two
    // hand-offs cannot drift apart.
    const onPick = capture.match(/onPick=\{\(choice\) => \{[\s\S]*?\n {12}\}\}/);
    expect(onPick, 'capture should wire GroupPicker.onPick').not.toBeNull();
    const body = onPick![0]!;
    expect(body).toMatch(/choice\.kind === 'later'/);
    expect(body).toMatch(/choice\.kind === 'me'/);
    expect(body).toMatch(/router\.push\(\s*assignCaptureHref\(\s*captureDraftFields\(/);
  });

  it("builds the hand-off from this screen's own live draft, not a saved row", () => {
    expect(capture).toMatch(
      /import \{ assignCaptureHref, captureDraftFields \} from '@\/lib\/captureAssign';/,
    );
    const call = capture.match(/captureDraftFields\(\{[\s\S]*?\}\)/);
    expect(call, 'capture should call captureDraftFields with its own state').not.toBeNull();
    for (const field of [
      'captureId',
      'description',
      'amount',
      'category',
      'categoryMeta',
      'location',
      'paymentMethod',
      'date',
    ]) {
      expect(call![0]).toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  it('writes "just me" through the shared planner, not a private copy', () => {
    // The same function Review and Bank messages file through, so a lunch kept
    // for oneself is the same ledger row whichever door it came in by —
    // including taking the capture's own id, which is what makes a retry
    // rewrite rather than duplicate.
    expect(capture).toMatch(/import \{ planPersonalPlacement \} from '@\/lib\/personalPlacement';/);
    expect(capture).toMatch(/planPersonalPlacement\(\{/);
  });

  it('closes the draft only after the record is queued, and only on an edit', () => {
    // Order is the whole guarantee: a draft closed before its record exists is
    // a spend that quietly disappeared. And there is nothing to close on a
    // fresh capture — it was never a row.
    const branch = capture.match(/if \(justMe\) \{[\s\S]*?\n {6}\}/);
    expect(branch, 'capture should have a just-me branch').not.toBeNull();
    const body = branch![0]!;
    expect(body.indexOf('upsertPersonal.mutateAsync')).toBeGreaterThan(-1);
    expect(body.indexOf('deleteCapture.mutateAsync')).toBeGreaterThan(
      body.indexOf('upsertPersonal.mutateAsync'),
    );
    expect(body).toMatch(/if \(isEditing\) await deleteCapture\.mutateAsync/);
  });

  it('never uploads a bill photo it cannot keep, and says so first', () => {
    // The personal ledger keeps amounts, not images. Uploading here would
    // spend somebody's storage on a file nothing could ever show them, and
    // finding that out after saving is finding out too late.
    const branch = capture.match(/if \(justMe\) \{[\s\S]*?\n {6}\}/);
    expect(branch![0]).not.toMatch(/uploadCapturePhoto/);
    expect(capture).toMatch(/justMeDropsPhoto/);
  });
});
