/**
 * Recovering a foreign-currency edit from a crash-recovery draft.
 *
 * `currency`/`fx` were added to the draft after drafts already existed on
 * devices. The bug this pins is the legacy draft: one written by an older build
 * has `currency` undefined, and the old code turned that into the group
 * currency — silently rewriting a foreign expense the next time it saved. A
 * draft that predates the field must defer to the currency the saved expense
 * was actually in, while an explicit null (the user really chose the group
 * currency) is left alone.
 */

import { describe, expect, it } from 'vitest';

import { resolveDraftCurrency, resolveDraftFx } from '@/lib/expenseDraft';
import type { FxRecord } from '@baaki/core';

describe('resolveDraftCurrency', () => {
  it('falls back to the saved expense currency for a legacy draft (undefined)', () => {
    // A draft written before the field existed, on an expense paid in USD.
    expect(resolveDraftCurrency(undefined, 'USD')).toBe('USD');
  });

  it('honours an explicit null as the intentional group currency', () => {
    // The user chose the group currency and it was persisted; keep it.
    expect(resolveDraftCurrency(null, 'USD')).toBeNull();
  });

  it('honours an explicit currency chosen in the draft', () => {
    expect(resolveDraftCurrency('EUR', 'USD')).toBe('EUR');
  });

  it('defers to a null version currency for a new-expense legacy draft', () => {
    // No saved version to fall back to → group currency (null) downstream.
    expect(resolveDraftCurrency(undefined, null)).toBeNull();
  });
});

describe('resolveDraftFx', () => {
  const rate = { source: 'you' } as unknown as FxRecord;

  it('recovers no rate from a legacy draft (undefined)', () => {
    expect(resolveDraftFx(undefined)).toBeNull();
  });

  it('honours an explicit null', () => {
    expect(resolveDraftFx(null)).toBeNull();
  });

  it('honours an explicit rate', () => {
    expect(resolveDraftFx(rate)).toBe(rate);
  });
});
