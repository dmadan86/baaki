/**
 * The long-press quick-add menu behind the dashboard's add icons.
 *
 * A short press on an add icon does the one obvious thing (scan a bill, open the
 * expense form). A long press instead raises this sheet — the whole family of
 * ways to start an expense in one place: type it, scan it, or speak it. It is
 * the phone-home-screen "quick actions" gesture, brought to the icons that add.
 *
 * A bottom sheet, not an anchored popover: it slides up from the bar the icons
 * sit on, matches the tip sheet's grammar, and sidesteps measuring an icon's
 * on-screen position to float a card beside it.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { iconSize, Text, tintForKey, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { useMotion } from '@/lib/motion';

export interface QuickAddAction {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  /** A stable key for the row's icon tint, so each action keeps its colour. */
  tintKey: string;
  /** Run on tap — the sheet closes first, then this fires. */
  onPress: () => void;
}

/**
 * Build the three standard ways to add an expense. Kept here so every add icon
 * that opens the sheet offers the same set, and a fresh scan nonce is minted at
 * press time (never in render) so the capture screen's consume-once guard holds.
 */
export function useQuickAddActions(): QuickAddAction[] {
  const { t } = useStrings();
  return [
    {
      icon: 'add',
      label: t.addExpense,
      tintKey: 'add',
      onPress: () => router.push('/capture'),
    },
    {
      icon: 'camera-outline',
      label: t.scanBill,
      tintKey: 'scan',
      onPress: () => router.push(`/capture?scan=${Date.now()}`),
    },
    {
      icon: 'mic-outline',
      label: t.voice.speakExpense,
      tintKey: 'voice',
      onPress: () => router.push('/voice'),
    },
  ];
}

export function QuickAddSheet({
  visible,
  onClose,
  actions,
}: {
  visible: boolean;
  onClose: () => void;
  actions: readonly QuickAddAction[];
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useStrings();
  const { animated } = useMotion();

  const activate = (action: QuickAddAction): void => {
    onClose();
    action.onPress();
  };

  return (
    <Modal
      transparent
      visible={visible}
      animationType={animated ? 'fade' : 'none'}
      onRequestClose={onClose}
    >
      {/* Tap the scrim to dismiss; the inner press is swallowed so tapping the
          sheet itself does not close it. */}
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t.common.close}
        style={{
          flex: 1,
          backgroundColor: 'rgba(10, 10, 26, 0.55)',
          justifyContent: 'flex-end',
        }}
      >
        <Pressable
          onPress={() => {}}
          accessibilityViewIsModal
          style={{
            backgroundColor: theme.color.surface,
            borderTopLeftRadius: theme.radius.xxl,
            borderTopRightRadius: theme.radius.xxl,
            paddingHorizontal: theme.spacing.lg,
            paddingTop: theme.spacing.md,
            paddingBottom: theme.spacing.md + insets.bottom,
            ...theme.shadow.lifted,
          }}
        >
          {/* The grab handle — the visual grammar of a sheet you can pull down. */}
          <View
            style={{
              alignSelf: 'center',
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: theme.color.border,
              marginBottom: theme.spacing.sm,
            }}
          />

          {actions.map((action) => {
            const tint = theme.tint[tintForKey(action.tintKey)];
            return (
              <Pressable
                key={action.label}
                onPress={() => activate(action)}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing.md,
                  paddingVertical: theme.spacing.md,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <View
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: tint.bg,
                  }}
                >
                  <Ionicons name={action.icon} size={iconSize.lg} color={tint.ink} />
                </View>
                <Text variant="subheading">{action.label}</Text>
              </Pressable>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
