/**
 * The entry, and nothing behind it yet.
 *
 * There is no paid tier to sell today — no store products, no prices, no
 * receipts. What there is, is a decision worth writing down before anything is
 * built on top of it: the ledger is free forever, and the only thing Baaki
 * would ever charge for is convenience. Splitting a bill, settling it, seeing
 * what you owe and being owed are not features to be taken away and sold back.
 *
 * So this screen says the boundary out loud and admits there is nothing to buy.
 * A row that leads nowhere would be worse than no row: somebody who taps
 * "Upgrade" and lands on a dead screen learns that the app is broken, and
 * somebody who finds a price list here learns something that is not true yet.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { Card, directionalIcon, IconButton, Row, Screen, Text, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';

/** What a paid tier would be for, and what it would never touch. */
const CONVENIENCES: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[] = [
  {
    icon: 'scan-outline',
    title: 'More scanned bills',
    body: 'Photograph a receipt and have the lines read off it. Every scan costs real money to run, which is the honest reason it is the thing with a limit.',
  },
  {
    icon: 'cloud-download-outline',
    title: 'Bigger exports and imports',
    body: 'Your data is yours and leaves in full for free. Larger jobs and scheduled backups are the convenience.',
  },
];

export default function UpgradeScreen() {
  const theme = useTheme();
  const { t } = useStrings();

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label="Back" onPress={() => router.back()}>
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.upgrade}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ backgroundColor: theme.color.brandSoft, gap: theme.spacing.md }}>
          {/* No badge saying "coming later". A brand badge on a brand-soft card
              is text with an invisible pill behind it, and the heading is
              already the whole announcement. */}
          <Text variant="subheading" tone="brand">
            Nothing to buy yet
          </Text>
          <Text variant="caption" tone="muted">
            This is the door, not the shop. When there is something worth paying for it will be
            here, with the price on it and no surprises.
          </Text>
        </Card>

        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            What would ever cost money
          </Text>
          {CONVENIENCES.map((item) => (
            <Card key={item.title} style={{ gap: theme.spacing.sm }}>
              <Row style={{ gap: theme.spacing.sm }}>
                <Ionicons name={item.icon} size={18} color={theme.color.brand} />
                <Text variant="subheading">{item.title}</Text>
              </Row>
              <Text variant="caption" tone="muted">
                {item.body}
              </Text>
            </Card>
          ))}
        </View>

        <Card style={{ gap: theme.spacing.sm }}>
          <Row style={{ gap: theme.spacing.sm }}>
            <Ionicons name="lock-open-outline" size={18} color={theme.color.positive} />
            <Text variant="subheading">What never will</Text>
          </Row>
          <Text variant="caption" tone="muted">
            The ledger. Groups, expenses, splits, balances, settling up, and getting all of it back
            out again — {t.freeForever.toLowerCase()}. A ledger you can only half read is not a
            ledger.
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}
