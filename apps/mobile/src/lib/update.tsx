/**
 * Whether the build somebody is holding is still allowed to run.
 *
 * The version number is compiled into the binary, so a build can only ever
 * describe itself — it cannot know that something newer exists. The policy
 * therefore lives on the server (`app_releases`, one row per store) and the app
 * asks. Two outcomes:
 *
 *   suggested — there is a newer build. A banner they can dismiss, and the
 *   dismissal sticks per version, or the banner becomes the thing they resent
 *   rather than the thing they act on.
 *
 *   required — this build may no longer talk to the server. A wall, because
 *   letting it through would put wrong numbers into a ledger other people read.
 *
 * Everything here fails towards opening the app. No answer, an unreadable
 * version, a policy that would block every build in existence: all of them come
 * out as `none`. Locking somebody out of their own ledger because a check
 * misfired is much worse than a stale client running one more day.
 *
 * One deliberate exception to failing open: a policy that *has* been fetched is
 * cached and honoured offline. "This build computes money wrongly" does not
 * stop being true because the phone lost signal, and every foreground re-checks
 * so a corrected policy takes effect as soon as there is a connection.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { AppState, Linking, Platform } from 'react-native';

import { decideUpdate, type UpdateDecision } from '@baaki/core';

import { fetchReleasePolicy } from '@/data/api';

const POLICY_KEY = 'baaki.release_policy';
const DISMISSED_KEY = 'baaki.update_dismissed';

interface CachedPolicy {
  latestVersion: string;
  minimumVersion: string;
  storeUrl: string;
  message: string | null;
}

interface UpdateValue {
  decision: UpdateDecision;
  /** The version installed on this phone. */
  installed: string;
  /** The newest build in the store, when known. */
  latest: string | null;
  /** Whatever the policy wanted said instead of the default copy. */
  message: string | null;
  /** Whether the suggestion has been waved away for this version. */
  dismissed: boolean;
  dismiss: () => void;
  /** Opens the store page. No-op when there is nowhere to send anybody. */
  openStore: () => void;
  /** Ask the server again — for the "try again" out on the blocking screen. */
  recheck: () => Promise<void>;
}

const UpdateContext = createContext<UpdateValue | null>(null);

/**
 * What this binary calls itself.
 *
 * `expo-constants` rather than `expo-application`: without `expo-updates` in
 * the project the JS bundle cannot be swapped after install, so the version
 * baked in at build time is the version running. That keeps this check free of
 * a native module, which matters — a native module missing from a build is how
 * this app has previously lost a whole screen.
 */
const INSTALLED = Constants.expoConfig?.version ?? '0.0.0';

/** Web has no store to send anybody to, so there is nothing to enforce. */
const STORE: 'ios' | 'android' | null =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : null;

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [policy, setPolicy] = useState<CachedPolicy | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const loaded = useRef(false);

  const refresh = useCallback(async () => {
    if (!STORE) return;
    try {
      const row = await fetchReleasePolicy(STORE);
      if (!row) return;
      const fresh: CachedPolicy = {
        latestVersion: row.latest_version,
        minimumVersion: row.minimum_version,
        storeUrl: row.store_url,
        message: row.message,
      };
      setPolicy(fresh);
      await AsyncStorage.setItem(POLICY_KEY, JSON.stringify(fresh)).catch(() => undefined);
    } catch {
      // Offline, or the server is having a bad day. Neither is a reason to
      // change what somebody is allowed to do with their own ledger.
    }
  }, []);

  useEffect(() => {
    if (!STORE) return;
    let active = true;

    void (async () => {
      // Cache first so a blocked build stays blocked without a round trip,
      // then the network answer replaces it.
      const raw = await AsyncStorage.getItem(POLICY_KEY).catch(() => null);
      const dismissed = await AsyncStorage.getItem(DISMISSED_KEY).catch(() => null);
      if (!active) return;
      if (raw) {
        try {
          setPolicy(JSON.parse(raw) as CachedPolicy);
        } catch {
          // A cache we cannot read is a cache we do not have.
        }
      }
      setDismissedVersion(dismissed);
      loaded.current = true;
      await refresh();
    })();

    // Somebody who leaves the app open for a week should still find out.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && loaded.current) void refresh();
    });

    return () => {
      active = false;
      subscription.remove();
    };
  }, [refresh]);

  const decision: UpdateDecision = policy
    ? decideUpdate(INSTALLED, {
        latestVersion: policy.latestVersion,
        minimumVersion: policy.minimumVersion,
      })
    : 'none';

  const dismiss = useCallback(() => {
    const version = policy?.latestVersion;
    if (!version) return;
    setDismissedVersion(version);
    void AsyncStorage.setItem(DISMISSED_KEY, version).catch(() => undefined);
  }, [policy?.latestVersion]);

  const openStore = useCallback(() => {
    const url = policy?.storeUrl;
    if (url) void Linking.openURL(url).catch(() => undefined);
  }, [policy?.storeUrl]);

  const value = useMemo<UpdateValue>(
    () => ({
      decision,
      installed: INSTALLED,
      latest: policy?.latestVersion ?? null,
      message: policy?.message ?? null,
      dismissed: dismissedVersion !== null && dismissedVersion === policy?.latestVersion,
      dismiss,
      openStore,
      recheck: refresh,
    }),
    [decision, policy, dismissedVersion, dismiss, openStore, refresh],
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdate(): UpdateValue {
  const value = useContext(UpdateContext);
  if (!value) throw new Error('useUpdate must be used inside UpdateProvider');
  return value;
}
