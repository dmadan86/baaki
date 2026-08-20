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
import { Modal, View } from 'react-native';

import { Button, Text, useTheme } from '@waves/ui';

import { useAuth } from '@/lib/auth';
import { enablePush, PushPermission, pushPermission, pushSupported } from '@/lib/push';

const SEEN_KEY = 'waves.push_prompt_seen';

export function NotificationPrompt() {
  const theme = useTheme();
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
    } finally {
      remember();
      setBusy(false);
      setVisible(false);
    }
  };

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
      <View
        style={{
          flex: 1,
          backgroundColor: '#00000080',
          alignItems: 'center',
          justifyContent: 'center',
          padding: theme.spacing.xxxl,
        }}
      >
        <View
          style={{
            width: '100%',
            maxWidth: 360,
            backgroundColor: theme.color.surface,
            borderRadius: theme.radius.lg,
            padding: theme.spacing.xxl,
            alignItems: 'center',
            gap: theme.spacing.lg,
            ...theme.shadow.lifted,
          }}
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
              Turn on notifications
            </Text>
            <Text variant="body" tone="muted" align="center">
              We&rsquo;ll let you know when someone adds an expense, settles up, or invites you to a
              group. No spam.
            </Text>
          </View>

          <View style={{ alignSelf: 'stretch', gap: theme.spacing.sm }}>
            <Button
              label="Enable"
              size="lg"
              fullWidth
              disabled={busy}
              onPress={() => void onEnable()}
            />
            <Button label="Not now" variant="ghost" size="lg" fullWidth onPress={dismiss} />
          </View>
        </View>
      </View>
    </Modal>
  );
}
