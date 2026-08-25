/**
 * The device cap, wired to a running app (free tier: two phones at a time).
 *
 * Three jobs, all quiet until they are not:
 *
 * It **registers** this phone whenever an account is signed in, and refreshes
 * that registration when the app comes back to the foreground — the heartbeat
 * that keeps a phone in daily use counted, and lets one left in a drawer fall
 * out of the count on its own after two weeks.
 *
 * It **reports** where the account stands. The database decides whether the
 * account is over its limit; this holds that answer and hands it to the gate.
 *
 * It **gates**, softly. A free account over the line is shown a sheet asking it
 * to sign the other phones out — never a locked door. Signing in on a phone can
 * always continue; what the person chooses is which two phones keep the session.
 * Guests have no cap (an anonymous account is one device by definition) and are
 * skipped entirely.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Modal, Pressable, View } from 'react-native';

import { type DeviceLimitStatus } from '@waves/core';
import { Button, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { registerDevice, signOutOtherDevices } from '@/data/api';
import { deviceIdentity } from '@/lib/device';
import { useAuth } from '@/lib/auth';
import { backend } from '@/lib/backend';

/** How stale a registration may get before a foreground refreshes it. */
const HEARTBEAT_MS = 60 * 60 * 1000;

interface DeviceSessionValue {
  /** Null until the first registration answers, or for guests. */
  status: DeviceLimitStatus | null;
  /**
   * Sign out every other device — GoTrue sessions and the table both. Resolves
   * to the number of registry rows retired, or null when the sessions were
   * revoked but that count could not be confirmed. Rejects only when the session
   * revocation itself failed (nothing was signed out).
   */
  signOutOthers: () => Promise<number | null>;
  /** Re-ask the server where the account stands. */
  refresh: () => Promise<void>;
}

const DeviceSessionContext = createContext<DeviceSessionValue | null>(null);

export function useDeviceSession(): DeviceSessionValue {
  const value = useContext(DeviceSessionContext);
  if (!value) throw new Error('useDeviceSession must be used inside DeviceSessionProvider');
  return value;
}

export function DeviceSessionProvider({ children }: { children: ReactNode }) {
  const { session, isGuest } = useAuth();
  const userId = session?.user?.id ?? null;
  const eligible = Boolean(userId) && !isGuest;

  const [status, setStatus] = useState<DeviceLimitStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const lastBeatAt = useRef(0);

  // Reset in render rather than an effect (the pattern `AuthProvider` uses):
  // the previous account's answer must not flash on the next one, and clearing
  // it here avoids a render that shows it.
  const [answeredFor, setAnsweredFor] = useState<string | null>(null);
  if (userId !== answeredFor) {
    setAnsweredFor(userId);
    setStatus(null);
    setDismissed(false);
  }

  const register = useCallback(async () => {
    if (!eligible) return;
    try {
      const identity = await deviceIdentity();
      const next = await registerDevice(identity);
      lastBeatAt.current = Date.now();
      setStatus(next);
    } catch {
      // Registration is best-effort: a failed call must never keep somebody out
      // of their own app. The next foreground tries again.
    }
  }, [eligible]);

  // Register on sign-in. Sign-out is handled by the render-phase reset above.
  // The work is an async IIFE (the pattern `AuthProvider` uses) so the state
  // update lands after the round trip rather than synchronously in the effect.
  useEffect(() => {
    if (!eligible) return;
    let active = true;
    void (async () => {
      try {
        const identity = await deviceIdentity();
        const next = await registerDevice(identity);
        if (!active) return;
        lastBeatAt.current = Date.now();
        setStatus(next);
      } catch {
        // Best-effort: a failed registration must never keep somebody out of
        // their own app. The next foreground tries again.
      }
    })();
    return () => {
      active = false;
    };
  }, [eligible, userId]);

  // Heartbeat: a foreground, throttled, is enough to keep last-seen fresh.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - lastBeatAt.current > HEARTBEAT_MS) {
        void register();
      }
    });
    return () => sub.remove();
  }, [register]);

  const signOutOthers = useCallback(async () => {
    const identity = await deviceIdentity();
    // The real session revocation first — this is the part that actually logs
    // the other phones out; the table update below only makes the list say so.
    // If this itself fails, nothing was revoked: surface the error, keep the gate.
    try {
      // signOut resolves with `{ error }` rather than throwing, so a revocation
      // failure has to be read off the result and re-thrown; otherwise the gate
      // below would dismiss on a sign-out that never happened.
      const { error } = await backend.auth.signOut({ scope: 'others' });
      if (error) throw error;
    } catch (caught) {
      await register();
      throw caught;
    }
    // The sessions are gone, so the gate has served its purpose whether or not
    // the registry table catches up. Dismiss before the reconciliation that can
    // still fail on a flaky network.
    setDismissed(true);
    try {
      const revoked = await signOutOtherDevices(identity.deviceId);
      await register();
      return revoked;
    } catch {
      // Only the list update failed; the sessions are already revoked. Refresh
      // what we can and report an unconfirmed count rather than a false zero.
      await register();
      return null;
    }
  }, [register]);

  const refresh = useCallback(async () => {
    await register();
  }, [register]);

  const showGate = eligible && status?.overLimit === true && !dismissed;

  return (
    <DeviceSessionContext.Provider value={{ status, signOutOthers, refresh }}>
      {children}
      {showGate ? (
        <DeviceLimitGate onDismiss={() => setDismissed(true)} onSignOutOthers={signOutOthers} />
      ) : null}
    </DeviceSessionContext.Provider>
  );
}

function DeviceLimitGate({
  onDismiss,
  onSignOutOthers,
}: {
  onDismiss: () => void;
  onSignOutOthers: () => Promise<number | null>;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const [busy, setBusy] = useState(false);

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onDismiss}>
      <Pressable
        onPress={onDismiss}
        style={{
          flex: 1,
          backgroundColor: 'rgba(20,20,43,0.45)',
          justifyContent: 'center',
          padding: theme.spacing.xl,
        }}
      >
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: theme.color.surface,
            borderRadius: theme.radius.xl,
            padding: theme.spacing.xl,
            gap: theme.spacing.lg,
            ...theme.shadow.lifted,
          }}
        >
          <Text variant="heading">{t.devices.gateTitle}</Text>
          <Text variant="body" tone="muted">
            {t.devices.gateBody}
          </Text>
          <View style={{ gap: theme.spacing.md }}>
            <Button
              label={t.devices.gateAction}
              disabled={busy}
              onPress={async () => {
                setBusy(true);
                try {
                  await onSignOutOthers();
                } catch {
                  // The failure is reported on the devices screen; here the gate
                  // simply stays up so the person can try again.
                } finally {
                  setBusy(false);
                }
              }}
            />
            <Button label={t.devices.gateDismiss} variant="secondary" onPress={onDismiss} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
