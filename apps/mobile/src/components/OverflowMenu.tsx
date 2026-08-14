/**
 * The header's overflow menu — the three-dot dropdown, WhatsApp-style.
 *
 * A translucent scrim over the app catches the tap-away, and a small rounded
 * card drops from the top-right corner with a short list of destinations. Each
 * row dismisses the menu and then routes, so the menu is never left open behind
 * the screen it opened.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text, useTheme } from '@baaki/ui';

export interface OverflowMenuItem {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  route: Href;
}

export function OverflowMenu({
  visible,
  onClose,
  items,
}: {
  visible: boolean;
  onClose: () => void;
  items: readonly OverflowMenuItem[];
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const go = (route: Href): void => {
    onClose();
    router.push(route);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* The scrim: a full-screen catcher so a tap anywhere off the card closes
          the menu. Kept barely tinted — the point is to dismiss, not to dim. */}
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.12)' }}
        accessibilityRole="button"
      >
        <View
          // Dropped from the top-right, clear of the status bar and roughly
          // where the header's three-dot sits. The shadow and the radius live on
          // this outer layer; the inner one clips the rows so a pressed row's
          // highlight follows the rounded corner instead of poking a square
          // through it (`overflow: 'hidden'` would eat the shadow if they shared
          // a layer, so they do not).
          style={{
            position: 'absolute',
            top: insets.top + 56,
            right: theme.spacing.xl,
            minWidth: 220,
            borderRadius: theme.radius.lg,
            ...theme.shadow.lifted,
          }}
        >
          <View
            style={{
              borderRadius: theme.radius.lg,
              borderWidth: 1,
              borderColor: theme.color.border,
              backgroundColor: theme.color.surface,
              paddingVertical: theme.spacing.xs,
              overflow: 'hidden',
            }}
          >
            {items.map((item) => (
              <Pressable
                key={item.label}
                onPress={() => go(item.route)}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing.md,
                  paddingHorizontal: theme.spacing.lg,
                  paddingVertical: theme.spacing.md,
                  backgroundColor: pressed ? theme.color.surfaceMuted : 'transparent',
                })}
              >
                <Ionicons name={item.icon} size={20} color={theme.color.textMuted} />
                <Text variant="body">{item.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}
