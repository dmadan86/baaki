import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { compareVersions, decideUpdate, parseVersion } from '../src/version/index';

describe('parseVersion', () => {
  it('reads dotted numbers', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion(' 0.1.0 ')).toEqual([0, 1, 0]);
    expect(parseVersion('12')).toEqual([12]);
  });

  it('refuses anything it would have to guess about', () => {
    for (const bad of ['', '1.2.3-beta', 'v1.2.3', '1..2', '1.2.', 'latest', '1.2.3.4a']) {
      expect(parseVersion(bad)).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('orders by segment, not by string', () => {
    // The string comparison every version check gets wrong once.
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
  });

  it('treats missing segments as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBe(-1);
  });

  it('returns null rather than a made-up ordering', () => {
    expect(compareVersions('1.2.0-rc1', '1.2.0')).toBeNull();
    expect(compareVersions('1.2.0', '')).toBeNull();
  });
});

describe('decideUpdate', () => {
  const policy = { latestVersion: '2.0.0', minimumVersion: '1.5.0' };

  it('blocks below the minimum', () => {
    expect(decideUpdate('1.4.9', policy)).toBe('required');
  });

  it('suggests between the minimum and the latest', () => {
    expect(decideUpdate('1.5.0', policy)).toBe('suggested');
    expect(decideUpdate('1.9.9', policy)).toBe('suggested');
  });

  it('says nothing at or beyond the latest', () => {
    expect(decideUpdate('2.0.0', policy)).toBe('none');
    // A build newer than the store's: every internal build, all the time.
    expect(decideUpdate('2.1.0', policy)).toBe('none');
  });

  it('ignores a minimum above the latest instead of blocking everybody', () => {
    // The typo that would otherwise lock every phone out of its own ledger,
    // including the one that installs the version it names.
    const broken = { latestVersion: '2.0.0', minimumVersion: '3.0.0' };
    expect(decideUpdate('2.0.0', broken)).toBe('none');
    expect(decideUpdate('1.0.0', broken)).toBe('suggested');
  });

  it('lets an unreadable version through', () => {
    expect(decideUpdate('1.2.0-internal', policy)).toBe('none');
    expect(decideUpdate('1.0.0', { latestVersion: 'unknown', minimumVersion: 'unknown' })).toBe(
      'none',
    );
  });
});

const version = fc
  .array(fc.integer({ min: 0, max: 999 }), { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join('.'));

describe('update decisions, as a property', () => {
  it('never requires an update from a version at or above the minimum', () => {
    fc.assert(
      fc.property(version, version, version, (installed, minimum, latest) => {
        const decision = decideUpdate(installed, {
          latestVersion: latest,
          minimumVersion: minimum,
        });
        if (decision !== 'required') return true;
        return (compareVersions(installed, minimum) ?? 0) < 0;
      }),
    );
  });

  it('never asks somebody to update to a version they already have', () => {
    fc.assert(
      fc.property(version, version, (installed, minimum) => {
        // Latest equal to installed: there is nothing in the store to go to.
        const decision = decideUpdate(installed, {
          latestVersion: installed,
          minimumVersion: minimum,
        });
        return decision === 'none';
      }),
    );
  });

  it('is symmetric about ordering', () => {
    fc.assert(
      fc.property(version, version, (a, b) => {
        const forward = compareVersions(a, b);
        const backward = compareVersions(b, a);
        return forward !== null && backward !== null && forward === -backward;
      }),
    );
  });
});
