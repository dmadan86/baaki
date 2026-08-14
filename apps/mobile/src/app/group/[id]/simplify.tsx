import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';

import {
  Avatar,
  Badge,
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
} from '@baaki/ui';

import { memberLookup, useGroup, useGroupLedger } from '@/data/hooks';
import { displayName } from '@/data/types';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

export default function SimplifyScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);
  const lookup = memberLookup(members.data);

  const nameOf = (memberId: string): string => {
    const member = lookup.get(memberId);
    return member ? displayName(member, profile?.id) : t.misc.someone;
  };

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
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.whoPaysWhom}</Text>
            <Text variant="micro" tone="muted">
              {group.data?.name}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.sm }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="subheading">
              {group.data?.simplify_debts ? t.simplifyOn : t.simplifyOff}
            </Text>
            <Badge label={`${ledger.transfers.length} payments`} tone="brand" />
          </Row>
          <Text variant="caption" tone="muted">
            {group.data?.simplify_debts
              ? 'Baaki suggests the fewest payments that settle the group. The real who-owes-whom ledger underneath is never rewritten.'
              : 'Showing the actual pairwise ledger, exactly as the expenses created it.'}
          </Text>
        </Card>

        {ledger.transfers.length === 0 ? (
          <EmptyState title={t.allSettled} body={t.group.nobodyOwes} />
        ) : (
          <Card padded={false} style={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}>
            {ledger.transfers.map((transfer) => (
              <Row
                key={`${transfer.from}-${transfer.to}-${transfer.amount}`}
                style={{ justifyContent: 'space-between' }}
              >
                <Row style={{ flex: 1 }}>
                  <Avatar name={nameOf(transfer.from)} size={38} />
                  <Ionicons
                    name={directionalIcon('arrow-forward')}
                    size={iconSize.base}
                    color={theme.color.textFaint}
                  />
                  <Avatar name={nameOf(transfer.to)} size={38} />
                  <View style={{ flex: 1, marginLeft: theme.spacing.sm }}>
                    <Text variant="body" numberOfLines={1}>
                      {`${nameOf(transfer.from)} → ${nameOf(transfer.to)}`}
                    </Text>
                    {transfer.from === ledger.myMemberId || transfer.to === ledger.myMemberId ? (
                      <Text variant="micro" tone="brand">
                        {transfer.from === ledger.myMemberId ? 'You pay' : 'You receive'}
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
