/**
 * The language, offered before there is anywhere to put a setting.
 *
 * The settings row is the right home for this once somebody is inside the app.
 * It is the wrong home for somebody standing at the front door who cannot read
 * the door — they would have to sign in, find the account tab, find the third
 * face of it, and scroll, all in a language they opened by accident. So the
 * choice is also offered flat, on the way in.
 *
 * A compact selector rather than a row of scripts: a globe, the language you
 * are in written in its own script, and a menu of the four. The globe is the
 * part that reads the same in every language — somebody who opened the app in a
 * script they cannot read is hunting for a symbol, and a symbol is what this
 * leads with. Tapping opens the list; the endonyms are the whole interaction.
 *
 * Choosing Arabic changes the words at once and the *direction* only after the
 * app is opened again — `@/i18n/language` explains why at length. Here that
 * costs one line of small print, and only while it is true.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Modal, Pressable, View } from 'react-native';

import { iconSize, Text, useTheme } from '@baaki/ui';

import { isRtlLanguage, LANGUAGE_NAMES, LANGUAGES, useStrings } from '@/i18n';
import { useLanguage } from '@/i18n/language';

export function LanguagePicker({ align = 'center' }: { align?: 'center' | 'flex-start' }) {
  const theme = useTheme();
  const { t } = useStrings();
  const { language, setLanguage, restartNeeded } = useLanguage();
  const [open, setOpen] = useState(false);

  const current = LANGUAGE_NAMES[language].own;

  return (
    <View
      style={{ gap: theme.spacing.sm, alignItems: align === 'center' ? 'center' : 'flex-start' }}
    >
      {/* The trigger. Globe first, because it is the one part somebody who
          opened the wrong language can still recognise. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t.language}: ${current}`}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          height: 44,
          paddingHorizontal: theme.spacing.lg,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.color.surface,
          borderWidth: 1,
          borderColor: theme.color.border,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Ionicons name="globe-outline" size={iconSize.md} color={theme.color.brand} />
        <Text variant="caption" style={{ fontWeight: '600' }}>
          {current}
        </Text>
        <Ionicons name="chevron-down" size={iconSize.base} color={theme.color.textMuted} />
      </Pressable>

      {restartNeeded ? (
        <Text variant="micro" tone="faint" align={align === 'center' ? 'center' : 'left'}>
          {isRtlLanguage(language) ? t.signIn.restartToMirror : t.signIn.restartToUnmirror}
        </Text>
      ) : null}

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        {/* Backdrop closes; the card swallows its own taps so a miss inside the
            menu does not dismiss it. */}
        <Pressable
          onPress={() => setOpen(false)}
          style={{
            flex: 1,
            backgroundColor: 'rgba(15, 10, 40, 0.4)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: theme.spacing.xxxl,
          }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              width: '100%',
              maxWidth: 340,
              backgroundColor: theme.color.surface,
              borderRadius: theme.radius.xl,
              paddingVertical: theme.spacing.sm,
              ...theme.shadow.lifted,
            }}
          >
            <Text
              variant="caption"
              tone="faint"
              style={{ paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm }}
            >
              {t.language}
            </Text>
            {LANGUAGES.map((entry) => {
              const active = entry === language;
              return (
                <Pressable
                  key={entry}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={LANGUAGE_NAMES[entry].own}
                  onPress={() => {
                    setOpen(false);
                    // Re-choosing the current language would fire the restart
                    // machinery for nothing.
                    if (!active) void setLanguage(entry);
                  }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginHorizontal: theme.spacing.sm,
                    paddingVertical: theme.spacing.md,
                    paddingHorizontal: theme.spacing.md,
                    borderRadius: theme.radius.md,
                    backgroundColor: active
                      ? theme.color.brandSoft
                      : pressed
                        ? theme.color.surfaceMuted
                        : 'transparent',
                  })}
                >
                  <Text
                    variant="body"
                    tone={active ? 'brand' : 'default'}
                    style={{ fontWeight: active ? '700' : '500' }}
                  >
                    {LANGUAGE_NAMES[entry].own}
                  </Text>
                  {active ? (
                    <Ionicons name="checkmark" size={iconSize.md} color={theme.color.brand} />
                  ) : null}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
