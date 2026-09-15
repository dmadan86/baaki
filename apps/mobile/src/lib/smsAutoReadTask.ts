/**
 * The hourly check, as an OS-scheduled job.
 *
 * `expo-background-task` is WorkManager on Android — a deferrable, batched
 * wake-up the system fits around whatever else it was going to do anyway. It
 * enforces a fifteen-minute floor and treats any interval as advice; an hour is
 * what this asks for and rather more than an hour is what it will often get,
 * which is the right shape for a job whose entire output is "the Review screen
 * is already up to date when you next open it".
 *
 * It is only ever registered on Android, only in a build that declares
 * `READ_SMS`, only for somebody in the treatment arm, and only while the
 * permission is actually granted. The foreground driver decides all four
 * (`smsAutoRead.ts`) and calls {@link syncAutoReadTask} with the verdict.
 *
 * ## Unregistering is the part that matters
 *
 * A registered WorkManager job outlives the process, the screen that started it
 * and the version of the app that thought it was a good idea. A job that kept
 * reading somebody's messages after they switched the feature off — or after
 * they revoked the permission in Settings, or signed out — is not a bug, it is
 * the kind of thing an app is removed from Play for. So it is torn down from
 * two directions and they are independent:
 *
 *   1. The driver calls `syncAutoReadTask(false)` the instant any gate shuts,
 *      which unregisters the job and clears the armed record.
 *   2. And the task itself stands down. Every run re-reads the armed record and
 *      re-checks the device gates, and a run that finds any of them shut
 *      unregisters itself before doing anything else. That is the branch that
 *      covers the case the first one cannot: a permission revoked from Android
 *      Settings while the app is not running, which raises no event anywhere.
 *
 * ## Why both modules are lazily required
 *
 * `expo-task-manager` and `expo-background-task` resolve their native modules
 * with `requireNativeModule`, which **throws** when the module is not in the
 * binary — at import, in the global scope, where nothing local catches it and
 * the app simply dies at launch. Two ways that happens: a development build
 * made before these dependencies were added, and — the one that would be
 * everybody at once — a JavaScript-only update delivered over the air to a
 * binary that predates them. Adding these packages makes the next release a
 * native build rather than an OTA, and this file is written so that getting
 * that wrong costs the hourly pass rather than the app.
 *
 * So both are reached through the same non-throwing loader the other native
 * wrappers in `lib/` use, `defineTask` included: it has to run in the global
 * scope of the bundle, because a headless wake-up loads the bundle and then
 * looks the task up by name, but "in the global scope" and "unguarded" are not
 * the same requirement. Defining a task is inert — it schedules nothing and
 * costs nothing until something registers it.
 */

import { deviceGatesOpen, runAutoReadFor } from './smsAutoReadRun';
import { disarmAutoRead, loadArmedOwner } from './smsAutoReadStore';

/** Namespaced, because WorkManager's job names are shared across the app. */
export const SMS_AUTO_READ_TASK = 'waves.sms-auto-read';

/**
 * Minutes. WorkManager's floor is fifteen and it will happily give us more than
 * we asked for; an hour is the promise the feature makes and the most infrequent
 * schedule that still means "opening the app rarely shows you stale work".
 */
const INTERVAL_MINUTES = 60;

type TaskManagerModule = typeof import('expo-task-manager');
type BackgroundTaskModule = typeof import('expo-background-task');

/**
 * The scheduler, or null on a binary that has no background task in it.
 *
 * Spelled out rather than held in a variable, unlike the optional package
 * `smsReader.ts` reaches for: Metro resolves `require` at build time, so a
 * computed specifier would leave these out of the bundle entirely and the
 * loader would return null on every phone, including the ones that are fine.
 * The literal is what gets them bundled; the `try` is what survives a binary
 * that predates them.
 */
function loadTaskManager(): TaskManagerModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-task-manager') as TaskManagerModule;
  } catch {
    return null;
  }
}

function loadBackgroundTask(): BackgroundTaskModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-background-task') as BackgroundTaskModule;
  } catch {
    return null;
  }
}

const taskManager = loadTaskManager();
const backgroundTask = loadBackgroundTask();

/**
 * One hourly pass, from a process that may have been started for nothing else.
 *
 * Everything it could learn is a reason to stop: no armed account, a shut gate,
 * a revoked permission. Nothing it could learn is a reason to say anything —
 * there is no notification, no toast and no report, and a pass that failed is
 * simply a pass that did not move `lastCheckedAt`.
 */
async function runScheduledPass(): Promise<number> {
  const success = backgroundTask?.BackgroundTaskResult.Success ?? 1;
  const failed = backgroundTask?.BackgroundTaskResult.Failed ?? 2;
  try {
    const ownerId = await loadArmedOwner();
    if (!ownerId) {
      // Nobody armed this. Either the feature was switched off while the app
      // was closed, or this job outlived the account that scheduled it.
      await unregisterAutoReadTask();
      return success;
    }

    // `runAutoReadFor` re-checks the device gates itself and refuses silently.
    // What it cannot say is whether this phone will go on refusing, so the
    // stand-down asks the gates directly rather than reading it off a failure.
    const outcome = await runAutoReadFor(ownerId);
    if (!outcome.read && !(await deviceGatesOpen())) {
      await disarmAutoRead();
      await unregisterAutoReadTask();
    }
    return success;
  } catch {
    return failed;
  }
}

// Global scope, guarded. See the header.
taskManager?.defineTask(SMS_AUTO_READ_TASK, runScheduledPass);

/**
 * Schedule the hourly job.
 *
 * Idempotent in the package itself — `registerTaskAsync` returns early when the
 * task is already registered — which is what keeps opening the app from
 * restarting WorkManager's clock every time.
 */
export async function registerAutoReadTask(): Promise<void> {
  try {
    await backgroundTask?.registerTaskAsync(SMS_AUTO_READ_TASK, {
      minimumInterval: INTERVAL_MINUTES,
    });
  } catch {
    // A phone with background work restricted (battery saver, a manufacturer's
    // own list) simply does not get the hourly pass. Foregrounding the app still
    // reads, which is the majority of the value, and there is nothing to say.
  }
}

/** Cancel it. Safe to call when nothing is scheduled. */
export async function unregisterAutoReadTask(): Promise<void> {
  try {
    await backgroundTask?.unregisterTaskAsync(SMS_AUTO_READ_TASK);
  } catch {
    // Nothing useful to do here; the task stands itself down on its next run.
  }
}

/**
 * Put the schedule where the gates say it should be.
 *
 * The one call the driver makes, so "registered" and "allowed to read" cannot
 * drift apart: on, it registers; off, it unregisters *and* disarms, because
 * those are the two independent stand-downs and a half-done teardown is the
 * failure this whole file is about.
 */
export async function syncAutoReadTask(enabled: boolean): Promise<void> {
  if (!enabled) {
    await disarmAutoRead();
    await unregisterAutoReadTask();
    return;
  }
  await registerAutoReadTask();
}

/**
 * Put the schedule where the person asked for it, without touching the armed
 * record.
 *
 * The two are different statements and were one function. Armed means "this
 * account passed every gate", which is what a headless wake-up reads and what a
 * shut gate must clear. The schedule is only whether the hourly wake-up is
 * wanted at all — somebody can turn it off and still have the reader work
 * perfectly well every time the app is opened, because that path is the
 * foreground driver and nothing here gates it.
 *
 * So switching the schedule off leaves the account armed and unregisters the
 * job. A gate shutting still goes through {@link syncAutoReadTask}, which does
 * both.
 */
export async function syncAutoReadSchedule(wanted: boolean): Promise<void> {
  if (wanted) await registerAutoReadTask();
  else await unregisterAutoReadTask();
}
