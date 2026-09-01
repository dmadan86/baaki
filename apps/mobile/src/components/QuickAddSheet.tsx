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
import { Pressable, View } from 'react-native';

import { iconSize, Sheet, Text, tintForKey, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';

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
  const { t } = useStrings();

  const activate = (action: QuickAddAction): void => {
    onClose();
    action.onPress();
  };

  return (
    <Sheet visible={visible} onClose={onClose} closeLabel={t.common.close}>
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
    </Sheet>
  );
}
