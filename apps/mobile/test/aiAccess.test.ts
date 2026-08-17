import { describe, expect, it } from 'vitest';

import { aiEnabled, resolveAiAccess } from '@/lib/aiAccessRule';

// A brought key that is on and under budget — the settings half of the byok inputs.
const liveKey = { keyEnabled: true, overLimit: false };

describe('resolveAiAccess', () => {
  it('is loading until the paid signal and key count are known', () => {
    expect(resolveAiAccess({ isPaid: undefined, keyCount: undefined, ...liveKey })).toBe('loading');
    expect(resolveAiAccess({ isPaid: true, keyCount: undefined, ...liveKey })).toBe('loading');
    expect(resolveAiAccess({ isPaid: undefined, keyCount: 2, ...liveKey })).toBe('loading');
  });

  it('is loading when a key exists but its settings are not in yet', () => {
    expect(
      resolveAiAccess({ isPaid: false, keyCount: 1, keyEnabled: undefined, overLimit: false }),
    ).toBe('loading');
    expect(
      resolveAiAccess({ isPaid: false, keyCount: 1, keyEnabled: true, overLimit: undefined }),
    ).toBe('loading');
  });

  it('lets a paid reader through on the managed key, whatever the key settings', () => {
    expect(resolveAiAccess({ isPaid: true, keyCount: 0, keyEnabled: false, overLimit: true })).toBe(
      'paid',
    );
    expect(resolveAiAccess({ isPaid: true, keyCount: 1, ...liveKey })).toBe('paid');
  });

  it('runs on the brought key when not paid, on, and under budget', () => {
    expect(resolveAiAccess({ isPaid: false, keyCount: 1, ...liveKey })).toBe('byok');
  });

  it('is paused when the key is present but switched off', () => {
    expect(
      resolveAiAccess({ isPaid: false, keyCount: 1, keyEnabled: false, overLimit: false }),
    ).toBe('paused');
  });

  it('is overlimit when the key is on but has hit its ceiling', () => {
    expect(resolveAiAccess({ isPaid: false, keyCount: 1, keyEnabled: true, overLimit: true })).toBe(
      'overlimit',
    );
  });

  it('is locked with no key at all', () => {
    expect(
      resolveAiAccess({ isPaid: false, keyCount: 0, keyEnabled: true, overLimit: false }),
    ).toBe('locked');
  });

  it('enables the features only when paid or a live brought key, never otherwise', () => {
    expect(aiEnabled('paid')).toBe(true);
    expect(aiEnabled('byok')).toBe(true);
    expect(aiEnabled('paused')).toBe(false);
    expect(aiEnabled('overlimit')).toBe(false);
    expect(aiEnabled('locked')).toBe(false);
    expect(aiEnabled('loading')).toBe(false);
  });
});
