import { describe, expect, it } from 'vitest';

import { aiEnabled, resolveAiAccess } from '@/lib/aiAccessRule';

describe('resolveAiAccess', () => {
  it('is loading until both inputs are known', () => {
    expect(resolveAiAccess({ isPaid: undefined, keyCount: undefined })).toBe('loading');
    expect(resolveAiAccess({ isPaid: true, keyCount: undefined })).toBe('loading');
    expect(resolveAiAccess({ isPaid: undefined, keyCount: 2 })).toBe('loading');
  });

  it('lets a paid reader through on the managed key, key or no key', () => {
    expect(resolveAiAccess({ isPaid: true, keyCount: 0 })).toBe('paid');
    expect(resolveAiAccess({ isPaid: true, keyCount: 3 })).toBe('paid');
  });

  it('falls to the brought key when not paid', () => {
    expect(resolveAiAccess({ isPaid: false, keyCount: 1 })).toBe('byok');
  });

  it('is locked with neither a plan nor a key', () => {
    expect(resolveAiAccess({ isPaid: false, keyCount: 0 })).toBe('locked');
  });

  it('enables the features when paid or keyed, never when locked or loading', () => {
    expect(aiEnabled('paid')).toBe(true);
    expect(aiEnabled('byok')).toBe(true);
    expect(aiEnabled('locked')).toBe(false);
    expect(aiEnabled('loading')).toBe(false);
  });
});
