/**
 * What the phone remembers about backing up: how often, over which networks,
 * and when the last one landed.
 *
 * Device-local, in AsyncStorage, like theme and motion and the sync-network
 * choice — not on the server. ADR-005 keeps this kind of preference on the
 * phone, and there is a sharper reason here: the whole point of the feature is
 * that the backup is between the person and their own Drive. Recording on
 * Waves' servers how often they back up, and when they last did, would put a
 * shadow of the thing on the server anyway.
 *
 * The network choice reuses `SyncNetworkPreference` rather than inventing a
 * second vocabulary for the same idea — same enum, same `networkAllows`
 * predicate, so the two can never disagree about what "Wi‑Fi only" means. It is
 * stored separately because it is a genuinely different decision: syncing a
 * shared ledger is a few hundred bytes on a change somebody is waiting to see,
 * and a backup is the whole ledger on a timer nobody is watching. Sync defaults
 * to any connection; backup defaults to Wi‑Fi.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { SyncNetworkPreference } from '../syncNetwork';
import { BackupFrequency, DEFAULT_FREQUENCY, parseFrequency } from './schedule';

const FREQUENCY_KEY = 'waves.backup.frequency';
const NETWORK_KEY = 'waves.backup.network';
const LAST_KEY = 'waves.backup.last';
/** Set once the person has been shown their recovery key and confirmed it. */
const KEY_SEEN_KEY = 'waves.backup.key_seen';

/**
 * A backup is bigger and less urgent than a sync flush, so it holds for Wi‑Fi
 * unless somebody says otherwise. Only Wi‑Fi and Both are offered on the screen
 * — "mobile data only" is a coherent sync choice and an incoherent backup one.
 */
export const DEFAULT_BACKUP_NETWORK = SyncNetworkPreference.Wifi;

/** What the last successful backup was, for the "Last backup" line. */
export interface LastBackup {
  /** Epoch ms. */
  readonly at: number;
  /** Bytes actually uploaded — the sealed file, not the ledger in memory. */
  readonly size: number;
  /** How many records it held. */
  readonly records: number;
}

export interface BackupSettings {
  readonly frequency: BackupFrequency;
  readonly network: SyncNetworkPreference;
  readonly last: LastBackup | null;
  /** False until the recovery key has been shown and acknowledged. */
  readonly keySeen: boolean;
}

function parseNetwork(raw: string | null): SyncNetworkPreference {
  return raw === SyncNetworkPreference.Wifi || raw === SyncNetworkPreference.Both
    ? raw
    : DEFAULT_BACKUP_NETWORK;
}

function parseLast(raw: string | null): LastBackup | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LastBackup>;
    if (typeof parsed?.at !== 'number' || !Number.isFinite(parsed.at)) return null;
    return {
      at: parsed.at,
      size: typeof parsed.size === 'number' && parsed.size >= 0 ? parsed.size : 0,
      records: typeof parsed.records === 'number' && parsed.records >= 0 ? parsed.records : 0,
    };
  } catch {
    return null;
  }
}

export async function loadBackupSettings(): Promise<BackupSettings> {
  const [frequency, network, last, keySeen] = await Promise.all([
    AsyncStorage.getItem(FREQUENCY_KEY).catch(() => null),
    AsyncStorage.getItem(NETWORK_KEY).catch(() => null),
    AsyncStorage.getItem(LAST_KEY).catch(() => null),
    AsyncStorage.getItem(KEY_SEEN_KEY).catch(() => null),
  ]);
  return {
    frequency: parseFrequency(frequency),
    network: parseNetwork(network),
    last: parseLast(last),
    keySeen: keySeen === '1',
  };
}

export async function saveFrequency(frequency: BackupFrequency): Promise<void> {
  // Storing the default is the same as storing nothing, so a reset-to-default
  // and a fresh install look identical — the same rule `syncNetwork` follows.
  if (frequency === DEFAULT_FREQUENCY) await AsyncStorage.removeItem(FREQUENCY_KEY);
  else await AsyncStorage.setItem(FREQUENCY_KEY, frequency);
}

export async function saveNetwork(network: SyncNetworkPreference): Promise<void> {
  if (network === DEFAULT_BACKUP_NETWORK) await AsyncStorage.removeItem(NETWORK_KEY);
  else await AsyncStorage.setItem(NETWORK_KEY, network);
}

export async function saveLastBackup(last: LastBackup): Promise<void> {
  await AsyncStorage.setItem(LAST_KEY, JSON.stringify(last));
}

export async function markKeySeen(): Promise<void> {
  await AsyncStorage.setItem(KEY_SEEN_KEY, '1');
}

/**
 * Forget everything this device remembered about backing up. Called on unlink
 * alongside the token and key wipes — the Drive file is untouched, since it is
 * the user's and the point of it is to outlive the app's state.
 */
export async function clearBackupSettings(): Promise<void> {
  await Promise.all(
    [FREQUENCY_KEY, NETWORK_KEY, LAST_KEY, KEY_SEEN_KEY].map((key) =>
      AsyncStorage.removeItem(key).catch(() => undefined),
    ),
  );
}
