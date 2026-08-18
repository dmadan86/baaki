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

import {
  Card,
  directionalIcon,
  IconButton,
  iconSize,
  ListRow,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { useStrings, type UiStrings } from '@/i18n';

/** What a paid tier would be for, and what it would never touch. */
function conveniences(
  t: UiStrings,
): { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[] {
  return [
    {
      icon: 'scan-outline',
      title: t.upgradeScreen.moreScans,
      body: t.upgradeScreen.moreScansBody,
    },
    {
      icon: 'cloud-download-outline',
      title: t.upgradeScreen.biggerTransfers,
      body: t.upgradeScreen.biggerTransfersBody,
    },
  ];
}

export default function UpgradeScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
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
            {t.upgradeScreen.nothingToBuy}
          </Text>
          <Text variant="caption" tone="muted">
            {t.upgradeScreen.nothingToBuyBody}
          </Text>
        </Card>

        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.upgradeScreen.whatWouldCost}
          </Text>
          {conveniences(t).map((item) => (
            <Card key={item.title} style={{ gap: theme.spacing.sm }}>
              <Row style={{ gap: theme.spacing.sm }}>
                <Ionicons name={item.icon} size={iconSize.md} color={theme.color.brand} />
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
            <Ionicons name="lock-open-outline" size={iconSize.md} color={theme.color.positive} />
            <Text variant="subheading">{t.upgradeScreen.whatNeverWill}</Text>
          </Row>
          <Text variant="caption" tone="muted">
            {t.upgradeScreen.whatNeverWillBody.replace('{free}', t.freeForever.toLowerCase())}
          </Text>
        </Card>

        {/* Last, and quiet. There is nothing to buy, so a code is the only way
            in — but a big button for it on the screen that says "nothing to
            buy" reads as a shop after all. */}
        <Card>
          <ListRow
            title={t.promo.row}
            subtitle={t.promo.rowHint}
            leading={
              <Ionicons name="pricetag-outline" size={iconSize.lg} color={theme.color.brand} />
            }
            trailing={
              <Ionicons
                name={directionalIcon('chevron-forward')}
                size={iconSize.md}
                color={theme.color.textFaint}
              />
            }
            onPress={() => router.push('/settings/redeem')}
          />
        </Card>
      </ScrollView>
    </Screen>
  );
}
