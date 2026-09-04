/**
 * The automatic half of "Automatic backup: Daily / Weekly / Monthly".
 *
 * A headless component, mounted once inside the lock and auth gates. It renders
 * nothing; it exists because the only honest source for the ledger is a hook,
 * and a hook needs somewhere to live.
 *
 * What it deliberately is *not* is a background task. There is no OS alarm here
 * — no `expo-background-task`, no `WorkManager`, no BGTaskScheduler. A phone
 * that has not been opened in a week has not backed up in a week, and the screen
 * says when the last one was rather than implying a schedule the OS never
 * promised to keep. (Both platforms treat background work as discretionary:
 * iOS decides when, or whether, a refresh task runs, and Android's Doze defers
 * everything on an idle device. An app that says "daily" and means it needs a
 * native module and a battery conversation, and that is a separate decision.)
 *
 * So: check when the app comes to the foreground, and once on mount. That is
 * enough to make a daily backup happen daily for anyone who opens the app
 * daily, which is the population the setting is for.
 */

import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { usePersonalRecords } from '@/data/personal';
import { useAuth } from '@/lib/auth';
import { reportHandled } from '@/lib/observability';

import { runBackup } from './engine';
import { loadRecoveryKey } from './recoveryKey';
import { isDue } from './schedule';
import { loadBackupSettings, saveLastBackup } from './settings';

/** Don't re-ask the question more than this often, however often we foreground. */
const CHECK_THROTTLE_MS = 5 * 60 * 1000;

export function AutoBackup() {
  const { session } = useAuth();
  const ownerId = session?.user?.id ?? '';
  const records = usePersonalRecords();

  // The newest ledger, read at the moment a check fires rather than captured
  // when the effect was set up — the effect must not re-subscribe to AppState
  // every time somebody adds an expense.
  const recordsRef = useRef(records);
  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  const lastCheckRef = useRef(0);

  useEffect(() => {
    if (!ownerId) return;
    let alive = true;

    const check = async (): Promise<void> => {
      const now = Date.now();
      if (now - lastCheckRef.current < CHECK_THROTTLE_MS) return;
      lastCheckRef.current = now;

      const settings = await loadBackupSettings(ownerId);
      if (!isDue(settings.last?.at ?? null, settings.frequency, now)) return;
      // Nothing goes out until the person has been shown the recovery key and
      // said they have it — a backup they cannot open is worse than none.
      if (!settings.keySeen) return;
      const key = await loadRecoveryKey(ownerId);
      if (!key) return;

      const result = await runBackup({
        ownerId,
        records: recordsRef.current,
        key,
        network: settings.network,
        // The whole point of the network preference is to gate *this* run.
        manual: false,
      });
      if (!alive || !result.ok) return;
      await saveLastBackup(ownerId, result.last);
    };

    // Everything in here is best effort and silent. An automatic backup that
    // failed is visible where it belongs — the "Last backup" line on the
    // settings screen, which will still be showing the older date — not as an
    // alert over whatever the person was actually doing.
    const run = (): void => {
      void check().catch((error: unknown) => reportHandled(error, 'backup.auto'));
    };

    run();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, [ownerId]);

  return null;
}
