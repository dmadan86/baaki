/**
 * The backup screen's whole state, in one hook.
 *
 * A React seam over three things that are not React — the settings on disk, the
 * OAuth tokens in the keystore, and the engine — plus the one thing that is: the
 * ledger itself, which only the mirror can produce. Kept out of the provider
 * tree on purpose. A backup is a settings screen and a once-a-day check, not
 * something every screen in the app needs a context for, and the app's provider
 * stack is already fifteen deep.
 *
 * A restore writes through the ordinary offline queue (`personal.upsert`), not
 * around it: the record ids in the backup are the same client-chosen ids that
 * are already the idempotency key, so restored rows converge with whatever the
 * server has exactly as a row typed on another phone would. That also means a
 * restore works with no connection at all — the rows land locally and leave when
 * the queue next drains, which is the ADR-005 promise applied to the one moment
 * people are least likely to have signal: setting up a new phone.
 */

import { useCallback, useEffect, useState } from 'react';

import { MutationKind, personalScope } from '@waves/core';

import { usePersonalRecordIds, usePersonalRecords } from '@/data/personal';
import { useAuth } from '@/lib/auth';
import { useSync } from '@/sync';

import { providerFor } from '../cloud/providers';
import { clearTokens, loadTokens, saveTokens } from '../cloud/tokens';
import type { SyncNetworkPreference } from '../syncNetwork';
import {
  PRIMARY_PROVIDER,
  runBackup,
  scanBackup,
  type BackupPhase,
  type BackupRefusal,
  type RestoreScan,
} from './engine';
import {
  bytesToHex,
  clearRecoveryKey,
  loadRecoveryKey,
  mintRecoveryKey,
  parseRecoveryKey,
  saveRecoveryKey,
} from './recoveryKey';
import { BackupFrequency } from './schedule';
import {
  clearBackupSettings,
  DEFAULT_BACKUP_NETWORK,
  loadBackupSettings,
  markKeySeen,
  saveFrequency,
  saveLastBackup,
  saveNetwork,
  type BackupSettings,
} from './settings';

/** What the screen says after a run: nothing yet, done, or a named refusal. */
export type BackupOutcome =
  | { readonly kind: 'ok'; readonly records: number }
  | { readonly kind: 'refused'; readonly refusal: BackupRefusal };

const NO_SETTINGS: BackupSettings = {
  frequency: BackupFrequency.Off,
  network: DEFAULT_BACKUP_NETWORK,
  last: null,
  keySeen: false,
};

export interface BackupState {
  /** False while the stored settings and tokens are still being read. */
  readonly loading: boolean;
  readonly settings: BackupSettings;
  /** False when this build has no OAuth client id — everything else is inert. */
  readonly configured: boolean;
  /** True when a Drive account is linked. */
  readonly connected: boolean;
  /** The linked account's address, or null when Drive would not say. */
  readonly account: string | null;
  /** True when this device holds the recovery key. */
  readonly hasKey: boolean;
  /** How many personal records a backup would carry right now. */
  readonly recordCount: number;
  /** Non-null while a backup is running. */
  readonly phase: BackupPhase | null;
  /** The result of the last run this session. */
  readonly outcome: BackupOutcome | null;
}

export interface BackupActions {
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  backupNow: () => Promise<BackupOutcome>;
  setFrequency: (frequency: BackupFrequency) => Promise<void>;
  setNetwork: (network: SyncNetworkPreference) => Promise<void>;
  /** Mint a key for this device and hand back its hex, for showing once. */
  createKey: () => Promise<string>;
  /** The key this device holds, as hex, or null. For "show it to me again". */
  revealKey: () => Promise<string | null>;
  /** Accept a key typed in from another device. False when it is not a key. */
  acceptKey: (input: string) => Promise<boolean>;
  /** Confirm the key has been written down. Backups refuse until this is set. */
  confirmKeySeen: () => Promise<void>;
  /** Read the Drive backup and say what restoring it would write. */
  scan: () => Promise<RestoreScan>;
  /** Queue the planned upserts. Returns how many were written. */
  applyRestore: (scan: Extract<RestoreScan, { ok: true }>) => Promise<number>;
}

export function useBackup(): BackupState & BackupActions {
  const { session } = useAuth();
  const { mutate, flush } = useSync();
  const ownerId = session?.user?.id ?? '';
  const records = usePersonalRecords();
  const localIds = usePersonalRecordIds();

  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<BackupSettings>(NO_SETTINGS);
  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [phase, setPhase] = useState<BackupPhase | null>(null);
  const [outcome, setOutcome] = useState<BackupOutcome | null>(null);

  const provider = providerFor(PRIMARY_PROVIDER);
  const configured = provider.isConfigured();

  const refreshAccount = useCallback(async (): Promise<void> => {
    const tokens = await loadTokens(PRIMARY_PROVIDER);
    setConnected(tokens !== null);
    if (!tokens) {
      setAccount(null);
      return;
    }
    // Best effort, and quietly: the address is a nicety, and a failed lookup
    // must not make a working link look broken.
    setAccount(
      await providerFor(PRIMARY_PROVIDER)
        .account(tokens)
        .catch(() => null),
    );
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [stored, key] = await Promise.all([loadBackupSettings(), loadRecoveryKey()]);
      if (!alive) return;
      setSettings(stored);
      setHasKey(key !== null);
      await refreshAccount();
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [refreshAccount]);

  const connect = useCallback(async (): Promise<boolean> => {
    const tokens = await provider.connect();
    // Null is a cancel — the person closed the consent page. Not an error, and
    // the caller must not dress it as one.
    if (!tokens) return false;
    await saveTokens(PRIMARY_PROVIDER, tokens);
    await refreshAccount();
    return true;
  }, [provider, refreshAccount]);

  const disconnect = useCallback(async (): Promise<void> => {
    const tokens = await loadTokens(PRIMARY_PROVIDER);
    // Hand the grant back to Google as well as forgetting it here, so "not
    // connected" is true in their account settings too. Best effort: a failed
    // revoke must not leave the app still claiming a link it has dropped.
    if (tokens) await provider.revoke?.(tokens).catch(() => undefined);
    await clearTokens(PRIMARY_PROVIDER);
    // The recovery key goes with the link. Keeping it would leave a key on the
    // phone for a file the app can no longer reach, and the person still has
    // their written copy, which is the only one that was ever load-bearing.
    await clearRecoveryKey();
    await clearBackupSettings();
    setSettings(NO_SETTINGS);
    setHasKey(false);
    setOutcome(null);
    await refreshAccount();
  }, [provider, refreshAccount]);

  const backupNow = useCallback(async (): Promise<BackupOutcome> => {
    const key = await loadRecoveryKey();
    if (!key) {
      const refused: BackupOutcome = { kind: 'refused', refusal: 'no-key' };
      setOutcome(refused);
      return refused;
    }
    setOutcome(null);
    try {
      const result = await runBackup({
        ownerId,
        records,
        key,
        network: settings.network,
        manual: true,
        onPhase: setPhase,
      });
      if (!result.ok) {
        const refused: BackupOutcome = { kind: 'refused', refusal: result.refusal };
        setOutcome(refused);
        // A dead grant clears the tokens inside the engine; reflect that here so
        // the screen swaps to "Connect" instead of offering a retry that cannot
        // work.
        if (result.refusal === 'auth') await refreshAccount();
        return refused;
      }
      await saveLastBackup(result.last);
      setSettings((current) => ({ ...current, last: result.last }));
      const done: BackupOutcome = { kind: 'ok', records: result.last.records };
      setOutcome(done);
      return done;
    } finally {
      setPhase(null);
    }
  }, [ownerId, records, settings.network, refreshAccount]);

  const setFrequencyAction = useCallback(async (frequency: BackupFrequency): Promise<void> => {
    setSettings((current) => ({ ...current, frequency }));
    await saveFrequency(frequency);
  }, []);

  const setNetworkAction = useCallback(async (network: SyncNetworkPreference): Promise<void> => {
    setSettings((current) => ({ ...current, network }));
    await saveNetwork(network);
  }, []);

  const createKey = useCallback(async (): Promise<string> => {
    const key = mintRecoveryKey();
    await saveRecoveryKey(key);
    setHasKey(true);
    return bytesToHex(key);
  }, []);

  const revealKey = useCallback(async (): Promise<string | null> => {
    const key = await loadRecoveryKey();
    return key ? bytesToHex(key) : null;
  }, []);

  const acceptKey = useCallback(async (input: string): Promise<boolean> => {
    const key = parseRecoveryKey(input);
    if (!key) return false;
    await saveRecoveryKey(key);
    setHasKey(true);
    // A key typed in from elsewhere has self-evidently been kept somewhere, so
    // there is nothing left to warn this person about.
    await markKeySeen();
    setSettings((current) => ({ ...current, keySeen: true }));
    return true;
  }, []);

  const confirmKeySeen = useCallback(async (): Promise<void> => {
    setSettings((current) => ({ ...current, keySeen: true }));
    await markKeySeen();
  }, []);

  const scan = useCallback(async (): Promise<RestoreScan> => {
    const key = await loadRecoveryKey();
    if (!key) return { ok: false, refusal: 'no-key' };
    return scanBackup({ ownerId, key, localIds });
  }, [ownerId, localIds]);

  const applyRestore = useCallback(
    async (result: Extract<RestoreScan, { ok: true }>): Promise<number> => {
      if (!ownerId) return 0;
      const scope = personalScope(ownerId);
      for (const record of result.plan.restore) {
        await mutate(MutationKind.PersonalUpsert, scope, {
          recordId: record.id,
          recordKind: record.kind,
          data: record.data,
        });
      }
      // Durable on disk already; this only asks the queue to leave sooner.
      void flush([scope]);
      return result.plan.restore.length;
    },
    [ownerId, mutate, flush],
  );

  return {
    loading,
    settings,
    configured,
    connected,
    account,
    hasKey,
    recordCount: records.length,
    phase,
    outcome,
    connect,
    disconnect,
    backupNow,
    setFrequency: setFrequencyAction,
    setNetwork: setNetworkAction,
    createKey,
    revealKey,
    acceptKey,
    confirmKeySeen,
    scan,
    applyRestore,
  };
}
