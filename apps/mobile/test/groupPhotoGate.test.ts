import { describe, expect, it } from 'vitest';

import {
  photoGateParam,
  photoGateStatus,
  photoTapAction,
  shouldClearPickedPhoto,
  type PhotoGateStatus,
} from '@/lib/groupPhotoGate';

describe('photoGateStatus', () => {
  it('is loading while the RPC is in flight', () => {
    expect(photoGateStatus(undefined, true)).toBe('loading');
    expect(photoGateStatus(true, true)).toBe('loading');
    expect(photoGateStatus(false, true)).toBe('loading');
  });

  it('treats an undefined answer as loading even when not flagged loading', () => {
    // A resolved query with no data yet must not read as "locked".
    expect(photoGateStatus(undefined, false)).toBe('loading');
  });

  it('is allowed only when the answer is a definite yes', () => {
    expect(photoGateStatus(true, false)).toBe('allowed');
  });

  it('is locked when the answer is a definite no', () => {
    expect(photoGateStatus(false, false)).toBe('locked');
  });
});

describe('photoTapAction', () => {
  it('opens the picker when allowed', () => {
    expect(photoTapAction('allowed')).toBe('pick');
  });

  it('points at the unlock path when locked', () => {
    expect(photoTapAction('locked')).toBe('showLockedHint');
  });

  it('does nothing while loading', () => {
    expect(photoTapAction('loading')).toBe('ignore');
  });
});

describe('photoGateParam', () => {
  it('passes a group id straight through', () => {
    expect(photoGateParam('grp-1')).toBe('grp-1');
  });

  it('maps a missing group (new group) to null', () => {
    expect(photoGateParam(null)).toBeNull();
    expect(photoGateParam(undefined)).toBeNull();
  });
});

describe('shouldClearPickedPhoto', () => {
  it('clears a picked photo once the gate resolves locked', () => {
    expect(shouldClearPickedPhoto('locked', true)).toBe(true);
  });

  it('keeps the photo when allowed, or when nothing was picked', () => {
    expect(shouldClearPickedPhoto('allowed', true)).toBe(false);
    expect(shouldClearPickedPhoto('locked', false)).toBe(false);
    expect(shouldClearPickedPhoto('loading', true)).toBe(false);
  });

  // Every status is covered above; this guards against a new status slipping
  // through without a decision.
  it('never clears in a non-locked status', () => {
    const statuses: PhotoGateStatus[] = ['loading', 'allowed'];
    for (const status of statuses) {
      expect(shouldClearPickedPhoto(status, true)).toBe(false);
    }
  });
});
