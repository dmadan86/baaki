import { describe, expect, it } from 'vitest';

import { handoverIsFresh, handoverKey, HANDOVER_TTL_MS } from '../src/lib/handover';

const receipt = {
  merchant: 'Anjappar',
  date: null,
  currency: 'INR',
  items: [],
  subtotal: null,
  taxes: [],
  serviceCharge: null,
  tip: null,
  discounts: [],
  grandTotal: 32000,
};

describe('handoverKey', () => {
  it('keys per group, so two open groups cannot swap bills', () => {
    expect(handoverKey('a')).not.toBe(handoverKey('b'));
  });
});

describe('handoverIsFresh', () => {
  const now = 1_700_000_000_000;

  it('carries a scan somebody has just taken', () => {
    expect(handoverIsFresh({ parsed: receipt, at: now - 1000 }, now)).toBe(true);
  });

  it('drops one nobody followed up on', () => {
    expect(handoverIsFresh({ parsed: receipt, at: now - HANDOVER_TTL_MS - 1 }, now)).toBe(false);
  });

  it('drops one stamped in the future rather than trusting it forever', () => {
    // A phone whose clock was corrected between the scan and the tap. Refusing
    // it costs one re-scan; trusting it means a bill that never goes stale.
    expect(handoverIsFresh({ parsed: receipt, at: now + 60_000 }, now)).toBe(false);
  });
});
