import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';

import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  IconButton,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
} from '@baaki/ui';

import { useStrings } from '@/i18n';
import { ME, getGroup, ledgerFor, memberName } from '@/mocks/data';

export default function SimplifyScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const group = getGroup(id ?? '');

  if (!group) {
    return (
      <Screen>
        <EmptyState title="Group not found" body="It may have been archived." />
      </Screen>
    );
  }

  const { transfers } = ledgerFor(group);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: 140,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label="Back" onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.whoPaysWhom}</Text>
            <Text variant="micro" tone="muted">
              {group.name}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.sm }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="subheading">{group.simplifyDebts ? t.simplifyOn : t.simplifyOff}</Text>
            <Badge label={`${transfers.length} payments`} tone="brand" />
          </Row>
          <Text variant="caption" tone="muted">
            {group.simplifyDebts
              ? 'Baaki suggests the fewest payments that settle the group. The real who-owes-whom ledger underneath is never rewritten — turn this off any time to see it.'
              : 'Showing the actual pairwise ledger, exactly as the expenses created it.'}
          </Text>
        </Card>

        {transfers.length === 0 ? (
          <EmptyState title={t.allSettled} body="Nobody owes anybody in this group." />
        ) : (
          <Card padded={false} style={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}>
            {transfers.map((transfer) => (
              <Row
                key={`${transfer.from}-${transfer.to}-${transfer.amount}`}
                style={{ justifyContent: 'space-between' }}
              >
                <Row style={{ flex: 1 }}>
                  <Avatar name={memberName(group, transfer.from)} size={38} />
                  <Ionicons name="arrow-forward" size={16} color={theme.color.textFaint} />
                  <Avatar name={memberName(group, transfer.to)} size={38} />
                  <View style={{ flex: 1, marginLeft: theme.spacing.sm }}>
                    <Text variant="body" numberOfLines={1}>
                      {`${memberName(group, transfer.from)} → ${memberName(group, transfer.to)}`}
                    </Text>
                    {transfer.from === ME || transfer.to === ME ? (
                      <Text variant="micro" tone="brand">
                        {transfer.from === ME ? 'You pay' : 'You receive'}
                      </Text>
                    ) : null}
                  </View>
                </Row>
                <MoneyText amount={transfer.amount} currency={transfer.currency} locale={locale} />
              </Row>
            ))}
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}
