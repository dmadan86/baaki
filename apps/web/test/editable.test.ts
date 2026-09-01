/**
 * The web editor's refusal to flatten a bill it cannot express.
 *
 * The app can record several payers; this form writes one. Without the guard,
 * opening such an expense on the web and saving it would move everybody's
 * contribution onto whoever came first — an invisible rewrite of a recorded
 * fact on an append-only ledger.
 */

import { describe, expect, it } from 'vitest';

import { tooManyPayersForWeb } from '../src/lib/editable';

describe('tooManyPayersForWeb', () => {
  it('refuses a bill with several payers', () => {
    expect(tooManyPayersForWeb({ payers: [{ member_id: 'a' }, { member_id: 'b' }] })).toBe(true);
  });

  it('opens the ordinary one-payer bill', () => {
    expect(tooManyPayersForWeb({ payers: [{ member_id: 'a' }] })).toBe(false);
  });

  it('opens a bill with no payer rows rather than dead-ending on it', () => {
    expect(tooManyPayersForWeb({ payers: [] })).toBe(false);
  });
});
