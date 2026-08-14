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

import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Modal, Pressable, ScrollView, TextInput, View } from 'react-native';

import { COUNTRIES, countryFlag, dialingCodeForCountry } from '@baaki/core';
import { Button, Row, Screen, Text, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';

/** The pickable countries: those the app stocks that also carry a dial code. */
const DIALABLE = COUNTRIES.filter((country) => dialingCodeForCountry(country.code));

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

  const dial = dialingCodeForCountry(code) ?? '+';
  const flag = countryFlag(code) ?? '🌐';

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return DIALABLE;
    return DIALABLE.filter((country) => {
      const d = dialingCodeForCountry(country.code) ?? '';
      return (
        country.name.toLowerCase().includes(q) ||
        d.includes(q) ||
        country.code.toLowerCase().includes(q)
      );
    });
  }, [query]);

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
        <Ionicons name="chevron-down" size={16} color={theme.color.textMuted} />
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={close}>
        <Screen edges={['top', 'bottom']}>
          <View
            style={{
              paddingHorizontal: theme.spacing.xl,
              paddingBottom: theme.spacing.md,
              gap: theme.spacing.sm,
            }}
          >
            <Text variant="heading">{t.pickers.dialCodeTitle}</Text>
            <TextInput
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t.pickers.searchCountry}
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel={t.pickers.searchCountry}
              style={{
                fontSize: 16,
                color: theme.color.text,
                backgroundColor: theme.color.surfaceMuted,
                borderRadius: theme.radius.md,
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.md,
              }}
            />
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

          <View style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.lg }}>
            <Button label={t.common.close} variant="ghost" fullWidth onPress={close} />
          </View>
        </Screen>
      </Modal>
    </>
  );
}
