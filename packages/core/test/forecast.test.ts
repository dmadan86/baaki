/**
 * Forecast pins the projection maths and its guards: no forecast before a trip
 * starts or without dates, the projection freezes to the actual once the trip
 * ends, and each currency is projected against only its own cap.
 */

import { describe, expect, it } from 'vitest';

import { forecast } from '../src/trip/forecast';

describe('forecast', () => {
  const dates = { startDate: '2026-03-14', endDate: '2026-03-20' }; // 7 days

  it('projects the pace so far across the whole trip', () => {
    // Day 3 of 7, ₹28,000 spent → pace 28000/3, projected 28000×7/3 = 65333.
    const [f] = forecast({
      spentByCurrency: { INR: 28000n },
      today: '2026-03-16',
      ...dates,
    });
    expect(f.elapsedDays).toBe(3);
    expect(f.totalDays).toBe(7);
    expect(f.dailyBurnMinor).toBe(9333n);
    expect(f.projectedTotalMinor).toBe(65333n);
  });

  it('measures the projection against a cap only in the cap’s currency', () => {
    const result = forecast({
      spentByCurrency: { INR: 28000n, THB: 5000n },
      budget: { amountMinor: 60000n, currency: 'INR' },
      today: '2026-03-16',
      ...dates,
    });
    const inr = result.find((f) => f.currency === 'INR');
    const thb = result.find((f) => f.currency === 'THB');
    expect(inr?.capMinor).toBe(60000n);
    expect(inr?.projectedOverrunMinor).toBe(5333n); // 65333 − 60000
    expect(inr?.onTrack).toBe(false);
    expect(thb?.capMinor).toBeNull(); // baht is not budgeted
    expect(thb?.onTrack).toBeNull();
  });

  it('gives a budgeted-but-unspent currency an on-track row', () => {
    const [f] = forecast({
      spentByCurrency: {},
      budget: { amountMinor: 60000n, currency: 'INR' },
      today: '2026-03-16',
      ...dates,
    });
    expect(f.currency).toBe('INR');
    expect(f.projectedTotalMinor).toBe(0n);
    expect(f.onTrack).toBe(true);
  });

  it('freezes the projection to the actual once the trip has ended', () => {
    const [f] = forecast({
      spentByCurrency: { INR: 70000n },
      today: '2026-03-25', // past the end
      ...dates,
    });
    expect(f.ended).toBe(true);
    expect(f.elapsedDays).toBe(7);
    expect(f.projectedTotalMinor).toBe(70000n); // no extrapolation past the end
  });

  it('returns nothing before the trip starts or without dates', () => {
    expect(forecast({ spentByCurrency: { INR: 1n }, today: '2026-03-10', ...dates })).toEqual([]);
    expect(forecast({ spentByCurrency: { INR: 1n }, today: '2026-03-16' })).toEqual([]);
  });
});
