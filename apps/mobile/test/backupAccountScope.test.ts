/**
 * A shared phone: A signs out, B signs in.
 *
 * Every store the backup subsystem uses is device-wide — the keystore for the
 * OAuth tokens and the recovery key, AsyncStorage for the schedule — and none
 * of them knows about accounts unless it is told. Unscoped, B's Backup screen
 * showed A's Google account linked, held A's recovery key, and inherited A's
 * schedule; worse, B's first backup would have found A's file under a fixed
 * filename and overwritten it with a ledger sealed to a different owner, which
 * A could then never open.
 *
 * Three guards, and this covers all three, because any one alone leaves a hole:
 * the keys carry the owner, sign-out wipes the departing account, and the
 * remote filename carries the owner too (for two Waves accounts sharing one
 * Google account, where scoped local keys do nothing).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the stand-ins are in place before the modules load their natives.
const hoisted = vi.hoisted(() => ({ keystore: new Map<string, string>() }));

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock-this-device-only',
  getItemAsync: async (key: string) => hoisted.keystore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    hoisted.keystore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    hoisted.keystore.delete(key);
  },
}));

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  },
}));

// The engine pulls the whole provider seam in at import time. Nothing in this
// file runs a backup or opens a browser, so these only have to load: the real
// react-native entry point is Flow-typed and unparseable outside Metro, and the
// auth-session modules reach for native views on import.
vi.mock('expo-network', () => ({
  getNetworkStateAsync: async () => ({ isInternetReachable: true, type: 'wifi' }),
  NetworkStateType: { WIFI: 'wifi', CELLULAR: 'cellular' },
}));

vi.mock('react-native', () => ({
  Platform: {
    OS: 'android',
    select: (options: Record<string, unknown>) => options.android ?? options.default,
  },
}));

vi.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: () => undefined }));

vi.mock('expo-auth-session', () => ({
  AuthRequest: class {},
  exchangeCodeAsync: async () => ({}),
  makeRedirectUri: () => 'waves://oauthredirect',
  refreshAsync: async () => ({}),
}));

const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
const { clearTokens, loadTokens, saveTokens } = await import('../src/lib/cloud/tokens');
const { bytesToHex, loadRecoveryKey, parseRecoveryKey, saveRecoveryKey } =
  await import('../src/lib/backup/recoveryKey');
const { loadBackupSettings, markKeySeen, saveFrequency, saveLastBackup, saveNetwork } =
  await import('../src/lib/backup/settings');
const { BackupFrequency } = await import('../src/lib/backup/schedule');
const { SyncNetworkPreference } = await import('../src/lib/syncNetwork');
const { backupFileName, clearBackupState } = await import('../src/lib/backup/engine');

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const TOKENS = { accessToken: 'at-a', refreshToken: 'rt-a', expiresAt: null };
const KEY_A = parseRecoveryKey('11'.repeat(32))!;

/** Everything a linked, scheduled, backed-up account leaves on the device. */
async function signInAndSetUp(ownerId: string): Promise<void> {
  await saveTokens('gdrive', ownerId, TOKENS);
  await saveRecoveryKey(ownerId, KEY_A);
  await markKeySeen(ownerId);
  await saveFrequency(ownerId, BackupFrequency.Daily);
  await saveNetwork(ownerId, SyncNetworkPreference.Both);
  await saveLastBackup(ownerId, { at: 1_757_000_000_000, size: 4096, records: 12 });
}

beforeEach(async () => {
  hoisted.keystore.clear();
  await AsyncStorage.clear();
});

describe('A signs out, B signs in', () => {
  it('leaves B with no Drive link, no key, and the plain defaults', async () => {
    await signInAndSetUp(A);
    await clearBackupState(A);

    expect(await loadTokens('gdrive', B)).toBeNull();
    expect(await loadRecoveryKey(B)).toBeNull();
    const settings = await loadBackupSettings(B);
    expect(settings.frequency).toBe(BackupFrequency.Off);
    expect(settings.network).toBe(SyncNetworkPreference.Wifi);
    expect(settings.last).toBeNull();
    expect(settings.keySeen).toBe(false);
  });

  it('really removes A’s credentials, not just hides them behind a key name', async () => {
    await signInAndSetUp(A);
    await clearBackupState(A);

    expect(await loadTokens('gdrive', A)).toBeNull();
    expect(await loadRecoveryKey(A)).toBeNull();
    expect(await loadBackupSettings(A)).toEqual({
      frequency: BackupFrequency.Off,
      network: SyncNetworkPreference.Wifi,
      last: null,
      keySeen: false,
    });
    // Nothing of A's is left anywhere in the keystore under any name.
    expect([...hoisted.keystore.keys()].filter((key) => key.includes('waves.'))).toEqual([]);
  });

  it('does not touch a third account signed in on the same phone', async () => {
    await signInAndSetUp(A);
    await signInAndSetUp(B);
    await clearBackupState(A);

    expect(await loadTokens('gdrive', B)).toEqual(TOKENS);
    expect((await loadBackupSettings(B)).frequency).toBe(BackupFrequency.Daily);
  });

  it('is a no-op with no owner, rather than wiping something arbitrary', async () => {
    await signInAndSetUp(A);
    await clearBackupState('');
    expect(await loadTokens('gdrive', A)).toEqual(TOKENS);
  });
});

describe('the stores are keyed by account even before any wipe', () => {
  it('does not hand B the tokens A granted', async () => {
    await saveTokens('gdrive', A, TOKENS);
    expect(await loadTokens('gdrive', A)).toEqual(TOKENS);
    expect(await loadTokens('gdrive', B)).toBeNull();
  });

  it('does not hand B the key that opens A’s backup', async () => {
    await saveRecoveryKey(A, KEY_A);
    expect(bytesToHex((await loadRecoveryKey(A))!)).toBe(bytesToHex(KEY_A));
    expect(await loadRecoveryKey(B)).toBeNull();
  });

  it('does not show B the schedule and last-backup time A set', async () => {
    await signInAndSetUp(A);
    const mine = await loadBackupSettings(B);
    expect(mine.frequency).toBe(BackupFrequency.Off);
    expect(mine.last).toBeNull();
  });

  it('unlinking one account leaves the other linked', async () => {
    await saveTokens('gdrive', A, TOKENS);
    await saveTokens('gdrive', B, TOKENS);
    await clearTokens('gdrive', A);
    expect(await loadTokens('gdrive', A)).toBeNull();
    expect(await loadTokens('gdrive', B)).toEqual(TOKENS);
  });

  it('reads and writes nothing at all for a signed-out caller', async () => {
    await saveTokens('gdrive', '', TOKENS);
    await saveRecoveryKey('', KEY_A);
    await saveFrequency('', BackupFrequency.Daily);
    expect(hoisted.keystore.size).toBe(0);
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
    expect(await loadTokens('gdrive', '')).toBeNull();
    expect(await loadRecoveryKey('')).toBeNull();
  });
});

describe('the remote filename', () => {
  it('carries the owner, so two Waves accounts on one Google account do not collide', () => {
    // This is the case scoped local keys cannot reach: both accounts hold their
    // own valid tokens into the *same* appDataFolder.
    expect(backupFileName(A)).not.toBe(backupFileName(B));
    expect(backupFileName(A)).toContain(A);
  });

  it('is stable for one owner, so a backup overwrites rather than accumulates', () => {
    expect(backupFileName(A)).toBe(backupFileName(A));
  });

  it('narrows the id rather than trusting it into a Drive query', () => {
    expect(backupFileName("x' or name!='")).toBe('waves-personal-backup-xorname.json');
  });
});
