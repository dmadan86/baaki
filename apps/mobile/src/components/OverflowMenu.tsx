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
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { iconSize, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { useMotion } from '@/lib/motion';

export interface OverflowMenuItem {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  /** Where the row goes. Omit when the row runs an action instead (`onPress`). */
  route?: Href;
  /** An in-app action instead of a route — e.g. replaying the tour. Takes
      precedence over `route`; the menu still closes first. */
  onPress?: () => void;
  // Optional grouping key. A divider is drawn between two consecutive items
  // whose `section` differs; items with no `section` never draw one, so a menu
  // that omits it (the group header) stays a flat, undivided list.
  section?: string;
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
  const { t } = useStrings();
  // The fade is decoration, not meaning — reduced motion drops it to an instant
  // present/dismiss (TDR §11 treats the setting as an input, not a hint).
  const { animated } = useMotion();

  const activate = (item: OverflowMenuItem): void => {
    onClose();
    if (item.onPress) item.onPress();
    else if (item.route) router.push(item.route);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType={animated ? 'fade' : 'none'}
      onRequestClose={onClose}
    >
      {/* The scrim: a full-screen catcher so a tap anywhere off the card closes
          the menu. Kept barely tinted — the point is to dismiss, not to dim. It
          carries a label so a screen reader announces "Close" rather than a bare
          unnamed button covering the whole screen. */}
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.12)' }}
        accessibilityRole="button"
        accessibilityLabel={t.common.close}
      >
        <View
          // Marks the dropdown as the modal layer so a screen reader confines
          // itself to the menu while it is open, instead of reading the screen
          // behind the scrim.
          accessibilityViewIsModal
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
            {items.map((item, index) => {
              // A divider sits at a section boundary only: both this row and the
              // one above it name a section, and the two differ. That rules out
              // a divider before the first row (no row above) and any menu that
              // leaves `section` unset (the group header), which stays flat.
              const previous = items[index - 1];
              const dividerAbove =
                previous !== undefined &&
                previous.section !== undefined &&
                item.section !== undefined &&
                previous.section !== item.section;
              return (
                <View key={item.label}>
                  {dividerAbove && (
                    <View
                      style={{
                        height: StyleSheet.hairlineWidth,
                        backgroundColor: theme.color.border,
                        marginVertical: theme.spacing.xs,
                      }}
                    />
                  )}
                  <Pressable
                    onPress={() => activate(item)}
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: theme.spacing.md,
                      // A 44pt floor rather than trusting the padding+text sum to
                      // clear it — a menu row is a primary tap target.
                      minHeight: 44,
                      paddingHorizontal: theme.spacing.lg,
                      paddingVertical: theme.spacing.md,
                      backgroundColor: pressed ? theme.color.surfaceMuted : 'transparent',
                    })}
                  >
                    <Ionicons name={item.icon} size={iconSize.lg} color={theme.color.textMuted} />
                    <Text variant="body">{item.label}</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}
