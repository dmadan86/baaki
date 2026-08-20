/**
 * The dial code in front of a phone number, as a thing you tap rather than type.
 *
 * The phone's region is only ever a starting guess — and a wrong one for anybody
 * whose display language is English (US) while they are sitting in India — so the
 * code is never a prefix baked into the field. It is its own control: a flag and
 * a `+NN` chip that opens a searchable list, and the number field beside it holds
 * only the local digits.
 *
 * The list is the same market set the rest of the app uses (`COUNTRIES`), each
 * paired with its dialing prefix. `+1` covers both the US and Canada — one plan,
 * two flags — so the chip shows the country that was actually picked, not a
 * guess back from the code.
 */

import { useEffect, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Modal, Pressable, ScrollView, TextInput, View } from 'react-native';

import { COUNTRIES, countryFlag, dialingCodeForCountry } from '@waves/core';
import { iconSize, Row, Screen, Text, useTheme } from '@waves/ui';

import { disabledCountries } from '@/data/api';
import { useStrings } from '@/i18n';

/** The pickable countries: those the app stocks that also carry a dial code. */
const DIALABLE = COUNTRIES.filter((country) => dialingCodeForCountry(country.code));

/**
 * The admin denylist, remembered for the run once fetched, so opening the
 * picker a second time does not go back to the network. `null` until the first
 * read answers; an empty set means "nothing disabled", which is also the safe
 * fallback when the read fails or the app is offline.
 */
let disabledCache: Set<string> | null = null;

export function CountryCodePicker({
  code,
  onChange,
}: {
  /** The selected country as an ISO-3166 alpha-2 code (e.g. `IN`). */
  code: string;
  onChange: (countryCode: string) => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [disabled, setDisabled] = useState<Set<string>>(() => disabledCache ?? new Set());

  const dial = dialingCodeForCountry(code) ?? '+';
  const flag = countryFlag(code) ?? '🌐';

  // The denylist, once per run. A failure or an offline phone leaves the set
  // empty, so every market stays offered rather than none.
  useEffect(() => {
    if (disabledCache) return;
    let cancelled = false;
    void disabledCountries().then((codes) => {
      const set = new Set(codes.map((entry) => entry.toUpperCase()));
      disabledCache = set;
      if (!cancelled) setDisabled(set);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The offered markets: the app's dialable set less anything the console has
  // switched off.
  const available = useMemo(
    () => DIALABLE.filter((country) => !disabled.has(country.code)),
    [disabled],
  );

  // If the guessed country turns out to be switched off, move the selection to
  // the first market that is still offered — otherwise the chip would show a
  // dial code the list will not let the person change.
  useEffect(() => {
    if (available.length === 0) return;
    if (!available.some((country) => country.code === code)) {
      onChange(available[0].code);
    }
  }, [available, code, onChange]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter((country) => {
      const d = dialingCodeForCountry(country.code) ?? '';
      return (
        country.name.toLowerCase().includes(q) ||
        d.includes(q) ||
        country.code.toLowerCase().includes(q)
      );
    });
  }, [query, available]);

  const close = (): void => {
    setOpen(false);
    setQuery('');
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${t.pickers.dialCodeTitle}, ${dial}`}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.xs,
          paddingVertical: theme.spacing.sm,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.radius.md,
          backgroundColor: theme.color.surfaceMuted,
        }}
      >
        <Text style={{ fontSize: 20 }}>{flag}</Text>
        <Text variant="subheading">{dial}</Text>
        <Ionicons name="chevron-down" size={iconSize.base} color={theme.color.textMuted} />
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={close}>
        <Screen edges={['top', 'bottom']} inModal>
          <View
            style={{
              paddingHorizontal: theme.spacing.xl,
              paddingBottom: theme.spacing.md,
              gap: theme.spacing.sm,
            }}
          >
            {/* Title on the left, a close X on the right in the primary ink —
                the way out sits at the top where the thumb reaches on a sheet,
                not buried under the list. */}
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text variant="heading">{t.pickers.dialCodeTitle}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.common.close}
                hitSlop={12}
                onPress={close}
                style={({ pressed }) => ({
                  width: 44,
                  height: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Ionicons name="close" size={iconSize.lg} color={theme.color.buttonPrimary} />
              </Pressable>
            </Row>

            {/* A leading search glyph, and a clear X once there is something to
                clear — the search box every list picker draws. */}
            <Row
              style={{
                gap: theme.spacing.sm,
                alignItems: 'center',
                backgroundColor: theme.color.surfaceMuted,
                borderRadius: theme.radius.md,
                paddingHorizontal: theme.spacing.lg,
              }}
            >
              <Ionicons name="search" size={iconSize.md} color={theme.color.textMuted} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={t.pickers.searchCountry}
                placeholderTextColor={theme.color.textFaint}
                accessibilityLabel={t.pickers.searchCountry}
                style={{
                  flex: 1,
                  fontSize: 16,
                  color: theme.color.text,
                  paddingVertical: theme.spacing.md,
                }}
              />
              {query.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear"
                  hitSlop={12}
                  onPress={() => setQuery('')}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                >
                  <Ionicons name="close-circle" size={iconSize.md} color={theme.color.textMuted} />
                </Pressable>
              ) : null}
            </Row>
          </View>

          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: theme.spacing.xl,
              paddingBottom: theme.spacing.xxxl,
              gap: theme.spacing.xs,
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {results.map((country) => {
              const selected = country.code === code;
              return (
                <Pressable
                  key={country.code}
                  onPress={() => {
                    onChange(country.code);
                    close();
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  style={{
                    paddingVertical: theme.spacing.md,
                    paddingHorizontal: theme.spacing.lg,
                    borderRadius: theme.radius.md,
                    backgroundColor: selected ? theme.color.brandSoft : theme.color.surface,
                  }}
                >
                  <Row style={{ gap: theme.spacing.md }}>
                    <Text style={{ fontSize: 24 }}>{countryFlag(country.code) ?? '🌐'}</Text>
                    <Text variant="subheading" style={{ flex: 1 }}>
                      {country.name}
                    </Text>
                    <Text variant="subheading" tone={selected ? 'brand' : 'muted'}>
                      {dialingCodeForCountry(country.code)}
                    </Text>
                  </Row>
                </Pressable>
              );
            })}
          </ScrollView>
        </Screen>
      </Modal>
    </>
  );
}
