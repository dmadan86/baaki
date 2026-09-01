/**
 * The soft ask for push, before the hard one.
 *
 * iOS gives an app exactly one shot at the system permission dialog — a "no"
 * there is close to permanent — so the kind thing is to ask in our own words
 * first, and only raise the real dialog for somebody who already said yes to
 * this. Android 13+ has the same one-shot shape. So a small centred card:
 * why we would notify, and Not now / Enable.
 *
 * Shown once, to a signed-in person on a real device whose permission is still
 * undetermined. "Not now" is a real answer — it is remembered, and the OS dialog
 * is never raised — and turning notifications on later still lives in settings.
 * A simulator reports its permission as denied, so this never appears there.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { View } from 'react-native';

import { Button, Popup, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { enablePush, PushPermission, pushPermission, pushSupported } from '@/lib/push';
import { usePromptSlot } from '@/lib/promptQueue';

const SEEN_KEY = 'waves.push_prompt_seen';

export function NotificationPrompt() {
  const theme = useTheme();
  const { t } = useStrings();
  const { session } = useAuth();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session || !pushSupported) return;
    let cancelled = false;

    void (async () => {
      // Asked already — never twice, whichever way they answered.
      const seen = await AsyncStorage.getItem(SEEN_KEY).catch(() => 'yes');
      if (seen === 'yes') return;
      // Only when the OS has not yet been asked. Granted needs nothing; a prior
      // denial is theirs to reverse in settings, not for us to nag.
      const permission = await pushPermission();
      if (!cancelled && permission === PushPermission.Undetermined) setVisible(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [session]);

  // Remembered the moment they answer, so a write that fails costs one repeat,
  // not a loop.
  const remember = (): void => {
    void AsyncStorage.setItem(SEEN_KEY, 'yes').catch(() => {});
  };

  const dismiss = (): void => {
    remember();
    setVisible(false);
  };

  const onEnable = async (): Promise<void> => {
    setBusy(true);
    try {
      // Raises the real dialog and, on a yes, registers and stores the token.
      // The result does not change what we do here: whether they allow or deny
      // at the OS level, the soft ask is done.
      await enablePush();
    } catch {
      // A failure to register is not worth surfacing on a soft ask — swallow it
      // so the onPress promise cannot reject unhandled; the finally still
      // remembers and closes.
    } finally {
      remember();
      setBusy(false);
      setVisible(false);
    }
  };

  // Sits in the shared prompt queue so the soft ask never lands on top of the
  // tour or the 3-card intro — it waits its turn and shows only when it is the
  // live winner. It outranks the campaign and guest asks (a permission the OS
  // will only offer once is worth more than an announcement).
  const granted = usePromptSlot({ id: 'notifPrompt', priority: 80, active: visible, delayMs: 300 });

  if (!visible || !granted) return null;

  return (
    <Popup
      visible
      onClose={dismiss}
      closeLabel={t.entry.notifyNotNow}
      style={{ maxWidth: 360, alignItems: 'center', gap: theme.spacing.lg }}
    >
      {/* The brand tile with a notification badge — the reference's own way
              of saying, wordlessly, what the ask is about. */}
          <View
            style={{
              width: 72,
              height: 72,
              borderRadius: 18,
              backgroundColor: theme.color.brand,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="notifications" size={38} color={theme.color.onBrand} />
            <View
              style={{
                position: 'absolute',
                top: -4,
                right: -4,
                width: 18,
                height: 18,
                borderRadius: 9,
                backgroundColor: theme.color.negative,
                borderWidth: 2,
                borderColor: theme.color.surface,
              }}
            />
          </View>

          <View style={{ gap: theme.spacing.sm }}>
            <Text variant="heading" align="center">
              {t.entry.notifyTitle}
            </Text>
            <Text variant="body" tone="muted" align="center">
              {t.entry.notifyBody}
            </Text>
          </View>

          <View style={{ alignSelf: 'stretch', gap: theme.spacing.sm }}>
            <Button
              label={t.entry.notifyEnable}
              size="lg"
              fullWidth
              disabled={busy}
              onPress={() => void onEnable()}
            />
            <Button
              label={t.entry.notifyNotNow}
              variant="ghost"
              size="lg"
              fullWidth
              onPress={dismiss}
            />
          </View>
    </Popup>
  );
}
