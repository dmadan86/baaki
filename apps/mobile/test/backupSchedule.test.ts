/**
 * When the next automatic backup is owed. The month boundaries are the only
 * part of this that has ever been wrong anywhere, so that is where the tests
 * are: 31 January plus a month must not be 3 March.
 */

import { describe, expect, it } from 'vitest';

import {
  BackupFrequency,
  DEFAULT_FREQUENCY,
  isDue,
  nextDueAt,
  parseFrequency,
} from '../src/lib/backup/schedule';

const DAY = 24 * 60 * 60 * 1000;
const at = (iso: string): number => new Date(iso).getTime();

describe('parsing a stored frequency', () => {
  it('takes the four it knows', () => {
    expect(parseFrequency('daily')).toBe(BackupFrequency.Daily);
    expect(parseFrequency('weekly')).toBe(BackupFrequency.Weekly);
    expect(parseFrequency('monthly')).toBe(BackupFrequency.Monthly);
    expect(parseFrequency('off')).toBe(BackupFrequency.Off);
  });

  it('falls back to off for anything else, including nothing stored', () => {
    expect(parseFrequency(null)).toBe(DEFAULT_FREQUENCY);
    expect(parseFrequency('hourly')).toBe(DEFAULT_FREQUENCY);
    expect(DEFAULT_FREQUENCY).toBe(BackupFrequency.Off);
  });
});

describe('when the next one is due', () => {
  it('is never, when the schedule is off', () => {
    expect(nextDueAt(at('2026-09-05T10:00:00Z'), BackupFrequency.Off)).toBeNull();
    expect(nextDueAt(null, BackupFrequency.Off)).toBeNull();
  });

  it('is now, when nothing has ever been backed up', () => {
    // Turning the schedule on should produce a backup, not a day of waiting.
    expect(isDue(null, BackupFrequency.Daily, at('2026-09-05T10:00:00Z'))).toBe(true);
    expect(isDue(null, BackupFrequency.Monthly, at('2026-09-05T10:00:00Z'))).toBe(true);
  });

  it('counts a day and a week from the last backup', () => {
    const last = at('2026-09-05T10:00:00Z');
    expect(nextDueAt(last, BackupFrequency.Daily)).toBe(last + DAY);
    expect(nextDueAt(last, BackupFrequency.Weekly)).toBe(last + 7 * DAY);
  });

  it('measures from the last run, not a fixed clock — a late run does not stack', () => {
    const late = at('2026-09-05T23:00:00Z');
    expect(isDue(late, BackupFrequency.Daily, at('2026-09-06T09:00:00Z'))).toBe(false);
    expect(isDue(late, BackupFrequency.Daily, at('2026-09-07T00:00:00Z'))).toBe(true);
  });

  it('is not due one second early, and is due exactly on time', () => {
    const last = at('2026-09-05T10:00:00Z');
    expect(isDue(last, BackupFrequency.Daily, last + DAY - 1)).toBe(false);
    expect(isDue(last, BackupFrequency.Daily, last + DAY)).toBe(true);
  });
});

describe('monthly, which is calendar months and not thirty days', () => {
  // Built from local-time parts: the arithmetic is local, so the assertions
  // must be too, or this passes in UTC and fails in Chennai.
  const local = (y: number, m: number, d: number): number =>
    new Date(y, m - 1, d, 9, 0, 0).getTime();
  const monthAndDay = (ms: number): [number, number] => {
    const date = new Date(ms);
    return [date.getMonth() + 1, date.getDate()];
  };

  it('lands on the same day of the next month', () => {
    expect(monthAndDay(nextDueAt(local(2026, 9, 5), BackupFrequency.Monthly)!)).toEqual([10, 5]);
  });

  it('clamps 31 January to the end of February rather than spilling into March', () => {
    expect(monthAndDay(nextDueAt(local(2026, 1, 31), BackupFrequency.Monthly)!)).toEqual([2, 28]);
  });

  it('clamps to 29 February in a leap year', () => {
    expect(monthAndDay(nextDueAt(local(2028, 1, 31), BackupFrequency.Monthly)!)).toEqual([2, 29]);
  });

  it('clamps 31 March to 30 April', () => {
    expect(monthAndDay(nextDueAt(local(2026, 3, 31), BackupFrequency.Monthly)!)).toEqual([4, 30]);
  });

  it('rolls the year over in December', () => {
    const due = new Date(nextDueAt(local(2026, 12, 15), BackupFrequency.Monthly)!);
    expect([due.getFullYear(), due.getMonth() + 1, due.getDate()]).toEqual([2027, 1, 15]);
  });

  it('keeps the time of day, so a backup does not creep across the clock', () => {
    const last = local(2026, 9, 5);
    const due = new Date(nextDueAt(last, BackupFrequency.Monthly)!);
    expect([due.getHours(), due.getMinutes()]).toEqual([9, 0]);
  });
});
