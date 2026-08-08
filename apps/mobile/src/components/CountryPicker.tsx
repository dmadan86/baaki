/**
 * Where a group settles.
 *
 * Not a flag-and-dial-code control — this only decides two things, and saying
 * which is more useful than a pretty list: **which payment rails the settle
 * screen offers**, and what currency a new group starts in. A group in the UAE
 * gets Aani and dirhams; the same group set to India gets UPI and rupees.
 *
 * The list is deliberately short and ordered by market rather than
 * alphabetically (see `COUNTRIES` in `@baaki/core`), because somebody in the
 * Gulf should not scroll past forty countries to find theirs. "Not set" is a
 * real, supported answer and stays first: a group with no country falls back to
 * bank, cash and the cross-border wallets, which is the right behaviour for a
 * group whose members are in four places.
 */

import { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';

import { COUNTRIES, countryName, railsFor } from '@baaki/core';
import { Button, Card, ListRow, Row, Screen, Text, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';

export function CountryRow({
  countryCode,
  onChange,
}: {
  countryCode: string | null;
  onChange: (countryCode: string | null) => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const [open, setOpen] = useState(false);

  // What this choice actually buys, said in the row rather than in a help page.
  const rails = railsFor(countryCode)
    .slice(0, 3)
    .map((rail) => rail.label)
    .join(', ');

  return (
    <>
      <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
        <ListRow
          title={t.pickers.country}
          subtitle={t.pickers.settlesWith
            .replace(
              '{country}',
              countryCode ? (countryName(countryCode) ?? countryCode) : t.pickers.notSet,
            )
            .replace('{rails}', rails)}
          onPress={() => setOpen(true)}
        />
      </Card>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <Screen edges={['top', 'bottom']}>
          <View
            style={{
              paddingHorizontal: theme.spacing.xl,
              paddingBottom: theme.spacing.lg,
              gap: theme.spacing.xs,
            }}
          >
            <Text variant="heading">Where does this group settle?</Text>
            <Text variant="caption" tone="muted">
              {t.pickers.countryNote}
            </Text>
          </View>

          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: theme.spacing.xl,
              paddingBottom: theme.spacing.xxxl,
              gap: theme.spacing.sm,
            }}
            showsVerticalScrollIndicator={false}
          >
            <Choice
              label={t.pickers.notSet}
              hint={t.pickers.notSetRails}
              selected={countryCode === null}
              onPress={() => {
                onChange(null);
                setOpen(false);
              }}
            />
            {COUNTRIES.map((country) => (
              <Choice
                key={country.code}
                label={country.name}
                hint={railsFor(country.code)
                  .slice(0, 3)
                  .map((rail) => rail.label)
                  .join(', ')}
                selected={countryCode === country.code}
                onPress={() => {
                  onChange(country.code);
                  setOpen(false);
                }}
              />
            ))}
          </ScrollView>

          <View style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.lg }}>
            <Button
              label={t.common.close}
              variant="ghost"
              fullWidth
              onPress={() => setOpen(false)}
            />
          </View>
        </Screen>
      </Modal>
    </>
  );
}

function Choice({
  label,
  hint,
  selected,
  onPress,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={{
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
        borderRadius: theme.radius.md,
        backgroundColor: selected ? theme.color.brandSoft : theme.color.surface,
      }}
    >
      <Row style={{ justifyContent: 'space-between' }}>
        <View style={{ flex: 1, paddingRight: theme.spacing.md }}>
          <Text variant="subheading">{label}</Text>
          <Text variant="micro" tone="muted">
            {hint}
          </Text>
        </View>
        {selected ? (
          <Text variant="subheading" tone="brand">
            ✓
          </Text>
        ) : null}
      </Row>
    </Pressable>
  );
}
