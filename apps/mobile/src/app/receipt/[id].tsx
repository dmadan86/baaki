import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { Linking, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';

import { Button, EmptyState, IconButton, iconSize, Screen, useTheme } from '@waves/ui';

import { fill, useStrings } from '@/i18n';
import { providerFor } from '@/lib/cloud/providers';
import { entryFor } from '@/lib/receiptIndex';
import { receiptFiles } from '@/lib/receiptStore';

/**
 * See the bill, any time after it was kept (E2).
 *
 * The receipt lives in the on-device vault, keyed by the expense id — never on
 * Waves. This screen reads it from there and shows it full-bleed, pinch to zoom.
 * When the local file is gone (a reinstall, a cleared vault) it does not simply
 * fail: if the receipt was backed up to a personal cloud, it says which one and,
 * when a share link is known, offers to open it; otherwise it explains the bill
 * is on the device it was added from. A missing receipt is a calm message, never
 * a crash.
 */
export default function ReceiptViewerScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  const { id, shareUrl } = useLocalSearchParams<{ id: string; shareUrl?: string }>();
  const receiptId = id ?? '';

  // Device-only and synchronous — the vault is a file lookup. Null on web, and
  // null once the file is gone, which is the fallback path below.
  const files = receiptFiles(receiptId);

  // Only consulted when the local image is missing, to tell the person where it
  // went. A backed-up receipt names its provider; anything else is "other
  // device". Read once on mount.
  const [cloudLabel, setCloudLabel] = useState<string | null>(null);
  useEffect(() => {
    if (files) return;
    let active = true;
    void (async () => {
      const entry = await entryFor(receiptId);
      if (!active) return;
      setCloudLabel(
        entry?.state === 'synced' && entry.provider ? providerFor(entry.provider).label : null,
      );
    })();
    return () => {
      active = false;
    };
  }, [files, receiptId]);

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
        <View style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.close} onPress={() => router.back()}>
            <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
          </IconButton>
        </View>

        {files ? (
          <ZoomableImage uri={files.imageUri} />
        ) : (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
              title={t.expense.receiptMissingTitle}
              body={
                cloudLabel
                  ? fill(t.expense.receiptMissingCloud, { provider: cloudLabel })
                  : t.expense.receiptMissingOtherDevice
              }
              action={
                // A share link means the owner opened the bill to the group from
                // their own Drive (E3) — anyone can open it, even without the
                // local file.
                shareUrl ? (
                  <Button
                    label={t.expense.viewReceipt}
                    onPress={() => void Linking.openURL(shareUrl).catch(() => undefined)}
                  />
                ) : undefined
              }
            />
          </View>
        )}
      </View>
    </Screen>
  );
}

const AnimatedImage = Animated.createAnimatedComponent(Image);

/**
 * The bill, pinch to zoom and drag to pan, double-tap to reset.
 *
 * Deliberately self-contained: the gestures live on shared values so the pan and
 * zoom stay on the UI thread, and the whole thing resets to fit on a double tap
 * so a person who zoomed in can always get back out. Clamped to a sane range so
 * the image can neither shrink to a dot nor fly off screen.
 */
function ZoomableImage({ uri }: { uri: string }): React.JSX.Element {
  const { width, height } = useWindowDimensions();

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      // Clamp between fit (1) and 5×, so it can neither vanish nor over-magnify.
      const next = Math.min(Math.max(savedScale.get() * event.scale, 1), 5);
      scale.set(next);
    })
    .onEnd(() => {
      savedScale.set(scale.get());
      if (scale.get() <= 1) {
        translateX.set(withTiming(0));
        translateY.set(withTiming(0));
        savedX.set(0);
        savedY.set(0);
      }
    });

  const pan = Gesture.Pan()
    .onUpdate((event) => {
      // Panning only makes sense once zoomed in; at fit it stays put.
      if (scale.get() <= 1) return;
      translateX.set(savedX.get() + event.translationX);
      translateY.set(savedY.get() + event.translationY);
    })
    .onEnd(() => {
      savedX.set(translateX.get());
      savedY.set(translateY.get());
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scale.set(withTiming(1));
      savedScale.set(1);
      translateX.set(withTiming(0));
      translateY.set(withTiming(0));
      savedX.set(0);
      savedY.set(0);
    });

  const composed = Gesture.Simultaneous(pinch, pan, doubleTap);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.get() },
      { translateY: translateY.get() },
      { scale: scale.get() },
    ],
  }));

  return (
    <GestureDetector gesture={composed}>
      <Animated.View style={{ flex: 1, justifyContent: 'center' }} collapsable={false}>
        <AnimatedImage
          source={{ uri }}
          style={[{ width, height: height * 0.8 }, animatedStyle]}
          contentFit="contain"
          transition={150}
        />
      </Animated.View>
    </GestureDetector>
  );
}
