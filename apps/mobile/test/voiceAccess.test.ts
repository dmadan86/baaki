import { describe, expect, it } from 'vitest';

import { pickVoiceMode, type VoiceAccess } from '@/lib/voiceAccess';

const free = (remainingSeconds: number | null): VoiceAccess => ({
  paid: false,
  freeSeconds: 300,
  usedSeconds: 300 - (remainingSeconds ?? 0),
  remainingSeconds,
  period: '2026-08',
});

const paid: VoiceAccess = {
  paid: true,
  freeSeconds: 300,
  usedSeconds: 0,
  remainingSeconds: null,
  period: '2026-08',
};

const online = { online: true, cloudEnabled: true };

describe('pickVoiceMode', () => {
  it('uses the on-device basic tier when offline', () => {
    expect(pickVoiceMode(paid, { online: false, cloudEnabled: true })).toBe('basic');
  });

  it('uses basic when cloud STT is switched off', () => {
    expect(pickVoiceMode(paid, { online: true, cloudEnabled: false })).toBe('basic');
  });

  it('uses basic when entitlement has not loaded yet', () => {
    expect(pickVoiceMode(null, online)).toBe('basic');
    expect(pickVoiceMode(undefined, online)).toBe('basic');
  });

  it('gives a paid person the cloud tier', () => {
    expect(pickVoiceMode(paid, online)).toBe('cloud');
  });

  it('gives a free person with allowance left the cloud tier', () => {
    expect(pickVoiceMode(free(120), online)).toBe('cloud');
  });

  it('falls a spent free person back to basic', () => {
    expect(pickVoiceMode(free(0), online)).toBe('basic');
  });

  it('treats a null remaining as unlimited (cloud)', () => {
    expect(pickVoiceMode(free(null), online)).toBe('cloud');
  });
});
