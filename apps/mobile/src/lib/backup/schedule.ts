/**
 * "Automatic backup: Off / Daily / Weekly / Monthly", and the one question that
 * setting has to answer — is a backup owed right now?
 *
 * Pure date arithmetic, kept away from the engine so it can be tested at the
 * month boundaries where it is actually wrong. Two things it deliberately does
 * not do:
 *
 * - It does not schedule. There is no background task waking the phone at 2am;
 *   the app checks whether one is owed when it comes to the foreground and runs
 *   it then. A phone that has not been opened in a week has not backed up in a
 *   week, and the screen says so honestly rather than claiming a schedule the
 *   OS never promised to keep. (iOS background execution is discretionary and
 *   Android's Doze defers alarms; an app that says "daily" and means it needs a
 *   native background worker, which is a native build and its own decision.)
 *
 * - It does not drift-correct. Each period is measured from the *last backup*,
 *   not from a fixed clock, so a run that happens late does not immediately make
 *   the next one due.
 *
 * Monthly is calendar months, not 30 days, and clamps: a backup on the 31st is
 * next due on the 28th/29th of February, not the 2nd or 3rd of March.
 */

export enum BackupFrequency {
  Off = 'off',
  Daily = 'daily',
  Weekly = 'weekly',
  Monthly = 'monthly',
}

export const BACKUP_FREQUENCIES: readonly BackupFrequency[] = [
  BackupFrequency.Off,
  BackupFrequency.Daily,
  BackupFrequency.Weekly,
  BackupFrequency.Monthly,
];

/** Off by default: nothing leaves the phone until somebody asks it to. */
export const DEFAULT_FREQUENCY = BackupFrequency.Off;

export function parseFrequency(raw: string | null): BackupFrequency {
  return BACKUP_FREQUENCIES.includes(raw as BackupFrequency)
    ? (raw as BackupFrequency)
    : DEFAULT_FREQUENCY;
}

/** Add `months` calendar months, clamping the day to the target month's length. */
function addMonths(from: Date, months: number): Date {
  const day = from.getDate();
  const shifted = new Date(from.getTime());
  // Move to the 1st before shifting the month, so the browser/Hermes rollover
  // (31 Jan + 1 month = 2 Mar) never happens, then clamp the day back on.
  shifted.setDate(1);
  shifted.setMonth(shifted.getMonth() + months);
  const lastDay = new Date(shifted.getFullYear(), shifted.getMonth() + 1, 0).getDate();
  shifted.setDate(Math.min(day, lastDay));
  return shifted;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the next automatic backup falls due, given when the last one succeeded.
 *
 * Null when the schedule is off. When nothing has ever been backed up the
 * answer is "now" — turning the schedule on should produce a backup rather than
 * wait a day for the first one, which is the difference between a feature that
 * works and one somebody has to be told about.
 */
export function nextDueAt(lastBackupAt: number | null, frequency: BackupFrequency): number | null {
  if (frequency === BackupFrequency.Off) return null;
  if (lastBackupAt === null) return 0;
  switch (frequency) {
    case BackupFrequency.Daily:
      return lastBackupAt + DAY_MS;
    case BackupFrequency.Weekly:
      return lastBackupAt + 7 * DAY_MS;
    case BackupFrequency.Monthly:
      return addMonths(new Date(lastBackupAt), 1).getTime();
    default:
      return null;
  }
}

/** Whether an automatic backup is owed at `now`. */
export function isDue(
  lastBackupAt: number | null,
  frequency: BackupFrequency,
  now: number,
): boolean {
  const due = nextDueAt(lastBackupAt, frequency);
  return due !== null && now >= due;
}
