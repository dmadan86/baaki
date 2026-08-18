import { describe, expect, it } from 'vitest';

import { receiptCapStatus, receiptTapAction } from '@/lib/receiptCapGate';

describe('receiptCapStatus', () => {
  it('is loading while the RPC is in flight', () => {
    expect(receiptCapStatus(undefined, true)).toBe('loading');
    expect(receiptCapStatus(true, true)).toBe('loading');
    expect(receiptCapStatus(false, true)).toBe('loading');
  });

  it('treats an undefined answer as loading even when not flagged loading', () => {
    // A resolved query with no data yet must not read as "locked".
    expect(receiptCapStatus(undefined, false)).toBe('loading');
  });

  it('is allowed only when the answer is a definite yes', () => {
    expect(receiptCapStatus(true, false)).toBe('allowed');
  });

  it('is locked when the answer is a definite no', () => {
    expect(receiptCapStatus(false, false)).toBe('locked');
  });
});

describe('receiptTapAction', () => {
  it('scans when allowed', () => {
    expect(receiptTapAction('allowed')).toBe('scan');
  });

  it('points at the unlock path when locked', () => {
    expect(receiptTapAction('locked')).toBe('showLockedHint');
  });

  it('does nothing while loading', () => {
    expect(receiptTapAction('loading')).toBe('ignore');
  });
});
