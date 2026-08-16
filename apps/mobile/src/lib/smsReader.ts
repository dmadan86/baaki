/**
 * Reading bank SMS off the phone, on Android, with the user's permission.
 *
 * The existing import screen is paste-based on purpose (see its header): iOS
 * gives no app SMS access at all, and Android's `READ_SMS` is a restricted
 * permission. This module is the opt-in Android path added on top — a one-tap
 * read of the inbox, gated behind a runtime permission prompt, that fills the
 * same candidate list the paste flow does.
 *
 * Two rules shape everything here:
 *
 *   - Nothing read ever leaves the device. The messages go straight to
 *     `proposeFromSms`, which parses on-device (ADR-013). A bank SMS carries an
 *     account tail, a balance and sometimes a one-time password; the whole
 *     point of parsing locally is that none of that is worth sending anywhere.
 *
 *   - It can never crash the app. The inbox reader is a native module that does
 *     not exist on iOS, in Expo Go, or in any build that did not include it, so
 *     it is loaded lazily behind a non-throwing check and every failure — no
 *     module, no permission, a read that errors — degrades to a described
 *     result the screen turns into a sentence, never an exception at launch or
 *     at the tap (the native-module rule the other `lib/*` wrappers follow).
 *
 * The logic is split from the wiring: `readSmsInbox` takes every side effect as
 * an injected dependency so all of it is unit-tested without a device, and
 * `readSms` is the thin production entry that supplies the real ones.
 */

import type { SmsMessage } from '@baaki/core';

export interface SmsWindow {
  /** Inclusive 'YYYY-MM-DD'. The trip's dates, usually. */
  readonly from: string;
  readonly to: string;
}

export enum SmsReadFailure {
  Unsupported = 'unsupported',
  Unavailable = 'unavailable',
  Denied = 'denied',
  Blocked = 'blocked',
  Failed = 'failed',
}

export type SmsReadResult =
  { ok: true; messages: SmsMessage[] } | { ok: false; reason: SmsReadFailure; message?: string };

/** A row as `react-native-get-sms-android` hands it back. */
export interface RawSms {
  readonly _id?: number | string;
  readonly address?: string | null;
  readonly body?: string | null;
  /** Epoch milliseconds the message was received. */
  readonly date?: number | string | null;
}

/** The single method this feature needs off the native module. */
export interface NativeSmsModule {
  list(
    filter: string,
    fail: (error: string) => void,
    success: (count: number, smsListJson: string) => void,
  ): void;
}

/** What a permission request resolves to, flattened to the three we act on. */
export enum PermissionOutcome {
  Granted = 'granted',
  Denied = 'denied',
  Blocked = 'blocked',
}

export interface SmsReaderDeps {
  readonly platformOS: string;
  /** Loads the native module lazily; returns null when it is not in this build. */
  readonly loadModule: () => NativeSmsModule | null;
  readonly requestPermission: () => Promise<PermissionOutcome>;
  /** Cap so a decade-long inbox cannot be walked in a single read. */
  readonly maxCount?: number;
}

const DEFAULT_MAX_COUNT = 500;
const DAY_MS = 86_400_000;

/** A native call that never answers is failed rather than left hanging forever. */
const READ_TIMEOUT_MS = 15_000;

/**
 * The native `list` filter for a date window.
 *
 * Widened by a day on each side and left to `proposeFromSms` to filter
 * authoritatively. The native `date` is when the message was *received*, which
 * can differ from when the payment happened by a timezone or a delayed SMS —
 * and dropping a message here that the parser would have kept is the one
 * mistake that loses an expense with no trace. A too-wide prefetch costs
 * nothing; a too-narrow one is silent.
 */
export function buildSmsFilter(window: SmsWindow, maxCount = DEFAULT_MAX_COUNT): string {
  const min = Date.parse(`${window.from}T00:00:00.000Z`);
  const max = Date.parse(`${window.to}T23:59:59.999Z`);
  const filter: Record<string, unknown> = { box: 'inbox', maxCount };
  if (Number.isFinite(min)) filter.minDate = min - DAY_MS;
  if (Number.isFinite(max)) filter.maxDate = max + DAY_MS;
  return JSON.stringify(filter);
}

/**
 * One raw row → the shape `proposeFromSms` reads, or null when it has no body.
 * The received time carries through so the parser can place a dateless message
 * (a bank SMS that names no date) on the day it actually arrived.
 */
export function mapSmsRow(raw: RawSms): SmsMessage | null {
  const body = typeof raw.body === 'string' ? raw.body : '';
  if (!body.trim()) return null;

  const ms = typeof raw.date === 'string' ? Number(raw.date) : raw.date;
  const receivedAt =
    typeof ms === 'number' && Number.isFinite(ms) && ms > 0
      ? new Date(ms).toISOString()
      : new Date().toISOString();

  const sender = typeof raw.address === 'string' && raw.address.trim() ? raw.address : undefined;
  return sender ? { body, receivedAt, sender } : { body, receivedAt };
}

/** Parse the native JSON payload into messages, tolerating a malformed blob. */
export function parseSmsList(json: string): SmsMessage[] {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];

  const out: SmsMessage[] = [];
  for (const row of rows) {
    if (row && typeof row === 'object') {
      const message = mapSmsRow(row as RawSms);
      if (message) out.push(message);
    }
  }
  return out;
}

/**
 * Read the inbox for a window, or say why it could not.
 *
 * The order is deliberate: platform first (an iPhone can never do this), then
 * the module (a build without it never can either), and only then the
 * permission prompt — asking for `READ_SMS` on a phone that has no reader to
 * use it would train the user to grant a permission that does nothing.
 */
export async function readSmsInbox(window: SmsWindow, deps: SmsReaderDeps): Promise<SmsReadResult> {
  if (deps.platformOS !== 'android') {
    return { ok: false, reason: SmsReadFailure.Unsupported };
  }

  let native: NativeSmsModule | null;
  try {
    native = deps.loadModule();
  } catch {
    native = null;
  }
  if (!native || typeof native.list !== 'function') {
    return { ok: false, reason: SmsReadFailure.Unavailable };
  }

  const outcome = await deps.requestPermission();
  if (outcome === PermissionOutcome.Denied) return { ok: false, reason: SmsReadFailure.Denied };
  if (outcome === PermissionOutcome.Blocked) return { ok: false, reason: SmsReadFailure.Blocked };

  const filter = buildSmsFilter(window, deps.maxCount ?? DEFAULT_MAX_COUNT);

  return new Promise<SmsReadResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (result: SmsReadResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    // A native module that answers with neither callback must not leave the
    // screen loading forever.
    timer = setTimeout(() => done({ ok: false, reason: SmsReadFailure.Failed }), READ_TIMEOUT_MS);
    try {
      native.list(
        filter,
        (error) => done({ ok: false, reason: SmsReadFailure.Failed, message: error }),
        (_count, json) => done({ ok: true, messages: parseSmsList(json) }),
      );
    } catch (error) {
      done({
        ok: false,
        reason: SmsReadFailure.Failed,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * The words shown in the Android runtime-permission dialog for READ_SMS.
 *
 * Threaded in from the screen rather than hardcoded here: this file is reached
 * on a background path with no `useStrings`, so the caller passes the reader's
 * own language, the same way the other non-hook lib helpers receive strings.
 */
export interface SmsPermissionRationale {
  readonly title: string;
  readonly message: string;
  readonly allow: string;
  readonly notNow: string;
}

/**
 * The real device wiring for `readSmsInbox`.
 *
 * Everything native is reached through `require` inside the callbacks, not at
 * module load: `react-native-get-sms-android` is absent on iOS, in Expo Go and
 * in any build that did not bundle it, and a top-level import would take the
 * whole app down at launch on those. The module specifier is held in a variable
 * so the type checker treats a missing module as `any` rather than an error —
 * this package is intentionally optional.
 */
export async function readSms(
  window: SmsWindow,
  rationale: SmsPermissionRationale,
): Promise<SmsReadResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Platform, PermissionsAndroid } = require('react-native') as typeof import('react-native');

  return readSmsInbox(window, {
    platformOS: Platform.OS,
    loadModule: () => {
      try {
        const specifier = 'react-native-get-sms-android';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(specifier) as { default?: NativeSmsModule } & NativeSmsModule;
        return (mod?.default ?? mod) as NativeSmsModule;
      } catch {
        return null;
      }
    },
    requestPermission: async () => {
      try {
        const status = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_SMS, {
          title: rationale.title,
          message: rationale.message,
          buttonPositive: rationale.allow,
          buttonNegative: rationale.notNow,
        });
        if (status === PermissionsAndroid.RESULTS.GRANTED) return PermissionOutcome.Granted;
        if (status === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return PermissionOutcome.Blocked;
        return PermissionOutcome.Denied;
      } catch {
        return PermissionOutcome.Denied;
      }
    },
  });
}
