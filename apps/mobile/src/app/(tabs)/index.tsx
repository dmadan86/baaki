import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { format } from '@baaki/core';
import {
  Avatar,
  AvatarStack,
  Badge,
  Card,
  IconButton,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  TintCard,
  useTheme,
} from '@baaki/ui';

import { fill, useStrings } from '@/i18n';
import { GROUPS, ME, ledgerFor, memberById, overallBalance } from '@/mocks/data';

export default function HomeScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const overall = overallBalance();
  const me = memberById(GROUPS[0]!, ME);

  const pendingCount = GROUPS.reduce(
    (count, group) => count + group.settlements.filter((s) => s.status === 'initiated').length,
    0,
  );

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: 170,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <Avatar name={me?.name ?? 'You'} emoji={me?.emoji} size={46} />
          <View style={{ flex: 1 }}>
            <Text variant="caption" tone="muted">
              {t.greeting},
            </Text>
            <Text variant="heading">{me?.name ?? 'You'}</Text>
          </View>
          <IconButton label="Search">
            <Ionicons name="search" size={20} color={theme.color.text} />
          </IconButton>
          <IconButton label="Notifications" badge={pendingCount > 0}>
            <Ionicons name="notifications-outline" size={20} color={theme.color.text} />
          </IconButton>
        </Row>

        {/* The headline number: one glance answers "am I up or down?" */}
        <Card
          style={{ backgroundColor: theme.color.brand, gap: theme.spacing.lg }}
          accessible
          accessibilityLabel={`${t.yourBaaki}: ${format(
            { minor: overall.net < 0n ? -overall.net : overall.net, currency: 'INR' },
            { locale, compactFraction: true },
          )} ${overall.net >= 0n ? t.youAreOwed : t.youOwe}`}
        >
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="caption" tone="onBrand" style={{ opacity: 0.8 }}>
              {t.yourBaaki}
            </Text>
            <Text variant="micro" tone="onBrand" style={{ opacity: 0.8 }}>
              {fill(t.acrossGroups, { count: GROUPS.length })}
            </Text>
          </Row>

          <View>
            <Text
              tone="onBrand"
              tabular
              style={{ fontSize: 40, lineHeight: 46, fontWeight: '700' }}
            >
              {format(
                { minor: overall.net < 0n ? -overall.net : overall.net, currency: 'INR' },
                { locale, compactFraction: true },
              )}
            </Text>
            {/* A bare number is ambiguous: say which way it points. */}
            <Text variant="caption" tone="onBrand" style={{ opacity: 0.85 }}>
              {overall.net === 0n ? t.allSettled : overall.net > 0n ? t.overallOwed : t.overallOwe}
            </Text>
          </View>

          <Row style={{ gap: theme.spacing.xxl }}>
            <View>
              <Text variant="micro" tone="onBrand" style={{ opacity: 0.75 }}>
                {t.youAreOwed}
              </Text>
              <Text variant="subheading" tone="onBrand" tabular>
                {format(
                  { minor: overall.owed, currency: 'INR' },
                  { locale, compactFraction: true },
                )}
              </Text>
            </View>
            <View>
              <Text variant="micro" tone="onBrand" style={{ opacity: 0.75 }}>
                {t.youOwe}
              </Text>
              <Text variant="subheading" tone="onBrand" tabular>
                {format(
                  { minor: overall.owing, currency: 'INR' },
                  { locale, compactFraction: true },
                )}
              </Text>
            </View>
          </Row>
        </Card>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.md }}>
          <QuickCard
            tint="peach"
            title={t.yourGroups}
            value={String(GROUPS.length)}
            caption={t.freeForever}
            icon="people"
          />
          <QuickCard
            tint="mint"
            title={t.toConfirm}
            value={String(pendingCount)}
            caption={t.settleUp}
            icon="time"
          />
          <QuickCard tint="sky" title="AI scans" value="20" caption={t.scansLeft} icon="scan" />
          <QuickCard
            tint="coral"
            title={t.simplify}
            value={GROUPS.filter((group) => group.simplifyDebts).length + '/' + GROUPS.length}
            caption={t.whoPaysWhom}
            icon="git-merge"
          />
        </View>

        <View>
          <SectionHeader
            title={t.yourGroups}
            action={
              <Text variant="caption" tone="brand">
                {t.newGroup}
              </Text>
            }
          />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {GROUPS.map((group, index) => {
              const { myBalance, pending } = ledgerFor(group);
              return (
                <View key={group.id}>
                  <ListRow
                    title={group.name}
                    subtitle={`${group.members.length} ${t.members}`}
                    leading={<Avatar name={group.name} emoji={group.emoji} tint={group.tint} />}
                    onPress={() => router.push(`/group/${group.id}`)}
                    trailing={
                      <View style={{ alignItems: 'flex-end', gap: 4 }}>
                        <MoneyText
                          amount={myBalance}
                          currency={group.currency}
                          locale={locale}
                          mode="balance"
                        />
                        {pending !== 0n ? (
                          <Badge label={t.pendingConfirmation} tone="brand" />
                        ) : null}
                      </View>
                    }
                  />
                  {index < GROUPS.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: theme.color.border }} />
                  ) : null}
                </View>
              );
            })}
          </Card>
        </View>

        <View>
          <SectionHeader title={t.members} />
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <AvatarStack
                names={[...new Set(GROUPS.flatMap((group) => group.members.map((m) => m.name)))]}
              />
              <Text variant="caption" tone="muted">
                {GROUPS.flatMap((group) => group.members).filter((m) => m.ghost).length}{' '}
                {t.notJoinedYet}
              </Text>
            </Row>
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}

function QuickCard({
  tint,
  title,
  value,
  caption,
  icon,
}: {
  tint: 'peach' | 'mint' | 'sky' | 'coral';
  title: string;
  value: string;
  caption: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  const theme = useTheme();
  const ink = theme.tint[tint].ink;

  return (
    <TintCard tint={tint} style={{ flexGrow: 1, flexBasis: '46%', gap: theme.spacing.sm }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text variant="caption" style={{ color: ink }} numberOfLines={1}>
          {title}
        </Text>
        <Ionicons name={icon} size={16} color={ink} />
      </Row>
      <Text variant="title" style={{ color: ink }} tabular>
        {value}
      </Text>
      <Text variant="micro" style={{ color: ink, opacity: 0.75 }} numberOfLines={1}>
        {caption}
      </Text>
    </TintCard>
  );
}
