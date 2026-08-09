import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { RefreshControl, ScrollView, View } from 'react-native';

import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Gradient,
  IconButton,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  tintForKey,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { useGroups, useHomeSummary } from '@/data/hooks';
import { plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { SyncBanner } from '@/components/SyncBanner';
import { SkeletonList } from '@/components/Skeletons';
import { GroupCard } from '@/components/GroupCard';
import { displayName, groupLabel } from '@/data/types';

export default function HomeScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const { profile, isGuest } = useAuth();

  const groups = useGroups();
  const summary = useHomeSummary(profile?.id ?? null);

  const list = groups.data ?? [];
  const loading = groups.isLoading || summary.isLoading;

  /**
   * The headline is one currency, because there is no such thing as a total
   * across several (ADR-004). The rest are counted underneath rather than added
   * in, which is what the profile screen already does with settled totals.
   *
   * With no groups there is nothing to be owed in, and the group currency the
   * app defaults to is the one to show a zero in.
   */
  const headline = summary.totals[0] ?? { currency: 'INR', net: 0n, owed: 0n, owing: 0n };
  const otherCurrencies = summary.totals.length - 1;

  /**
   * Which action is waiting to be told a group.
   *
   * Both headline actions need one, and guessing is worse than asking: an
   * expense filed against the wrong trip is a debt somebody has to notice and
   * unpick. With no groups the question is "start one"; with exactly one there
   * is nothing to ask.
   */
  const [pending, setPending] = useState<'add-expense' | 'settle' | null>(null);

  const start = (action: 'add-expense' | 'settle'): void => {
    const only = list.length === 1 ? list[0] : undefined;
    if (list.length === 0) router.push('/new-group');
    else if (only) router.push(`/group/${only.id}/${action}`);
    else setPending(action);
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={(groups.isFetching || summary.isFetching) && !loading}
            onRefresh={() => {
              void groups.refetch();
              summary.refetch();
            }}
            tintColor={theme.color.brand}
          />
        }
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          {/* Your own face at the top of your own dashboard reads as a way in
              to your account, so it is one. It goes to the same place the last
              tab does rather than somewhere only reachable from here — two
              routes to one screen, not a second screen that drifts. */}
          <Avatar
            name={profile?.display_name ?? 'You'}
            size={46}
            accessibilityLabel={t.profile}
            onPress={() => router.navigate('/profile')}
          />
          <View style={{ flex: 1 }}>
            <Text variant="caption" tone="muted">
              {t.greeting},
            </Text>
            <Text variant="heading" numberOfLines={1}>
              {profile?.display_name ?? 'You'}
            </Text>
          </View>
          <IconButton label={t.newGroup} onPress={() => router.push('/new-group')}>
            <Ionicons name="add" size={22} color={theme.color.text} />
          </IconButton>
        </Row>

        <SyncBanner />

        {isGuest ? (
          <Card style={{ backgroundColor: theme.color.brandSoft, gap: theme.spacing.sm }}>
            <Text variant="subheading" tone="brand">
              {t.tabs.guestBanner}
            </Text>
            <Text variant="caption" tone="muted">
              {t.tabs.guestBannerBody}
            </Text>
            <Button
              label={t.tabs.addYourDetails}
              variant="secondary"
              size="sm"
              onPress={() => router.push('/settings/account')}
            />
          </Card>
        ) : null}

        {/* Headline: one glance answers "am I up or down?" */}
        <Gradient
          radius={theme.radius.md}
          style={{ padding: theme.spacing.xl, gap: theme.spacing.lg }}
        >
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="caption" tone="onBrand" style={{ opacity: 0.8 }}>
              {t.yourBaaki}
            </Text>
            <Text variant="micro" tone="onBrand" style={{ opacity: 0.8 }}>
              {plural(locale, list.length, t.tabs.acrossGroups)}
            </Text>
          </Row>

          <View>
            <MoneyText
              amount={headline.net < 0n ? -headline.net : headline.net}
              currency={headline.currency as never}
              locale={locale}
              tone="onBrand"
              style={{ fontSize: 40, lineHeight: 46, fontWeight: '700' }}
            />
            <Text variant="caption" tone="onBrand" style={{ opacity: 0.85 }}>
              {headline.net === 0n
                ? t.allSettled
                : headline.net > 0n
                  ? t.overallOwed
                  : t.overallOwe}
            </Text>
            {/* No rate turns rupees into euros, so the rest are counted, not added. */}
            {otherCurrencies > 0 ? (
              <Text variant="micro" tone="onBrand" style={{ opacity: 0.75 }}>
                {plural(locale, otherCurrencies, t.account.otherCurrencies)}
              </Text>
            ) : null}
          </View>

          <Row style={{ gap: theme.spacing.xxl }}>
            <View>
              <Text variant="micro" tone="onBrand" style={{ opacity: 0.75 }}>
                {t.youAreOwed}
              </Text>
              <MoneyText
                amount={headline.owed}
                currency={headline.currency as never}
                locale={locale}
                tone="onBrand"
              />
            </View>
            <View>
              <Text variant="micro" tone="onBrand" style={{ opacity: 0.75 }}>
                {t.youOwe}
              </Text>
              <MoneyText
                amount={headline.owing}
                currency={headline.currency as never}
                locale={locale}
                tone="onBrand"
              />
            </View>
          </Row>

          {/* The two things anybody opens Baaki to do, where the balance they
              just read is still on screen. Which group they mean is asked
              below only when there is more than one answer. */}
          <Row style={{ gap: theme.spacing.md }}>
            <Button
              label={t.addExpense}
              variant="onBrand"
              style={{ flex: 1 }}
              icon={<Ionicons name="add-circle-outline" size={18} color={theme.color.brand} />}
              onPress={() => start('add-expense')}
            />
            <Button
              label={t.settleUp}
              variant="onBrandOutline"
              style={{ flex: 1 }}
              icon={
                <Ionicons name="swap-horizontal-outline" size={18} color={theme.color.onBrand} />
              }
              onPress={() => start('settle')}
            />
          </Row>
        </Gradient>

        {pending ? (
          <Card style={{ gap: theme.spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text variant="subheading">
                {pending === 'add-expense' ? t.addExpense : t.settleUp}
              </Text>
              <Text variant="caption" tone="brand" onPress={() => setPending(null)}>
                {t.cancel}
              </Text>
            </Row>
            <Text variant="caption" tone="muted">
              {t.whichGroup}
            </Text>
            {list.map((group) => (
              <ListRow
                key={group.id}
                title={groupLabel(group, summary.membersFor(group.id), profile?.id)}
                leading={
                  <Avatar
                    name={groupLabel(group, summary.membersFor(group.id), profile?.id)}
                    emoji={group.cover_emoji ?? undefined}
                    tint={tintForKey(group.id)}
                    size={36}
                  />
                }
                onPress={() => {
                  setPending(null);
                  router.push(`/group/${group.id}/${pending}`);
                }}
              />
            ))}
          </Card>
        ) : null}

        {loading ? (
          <SkeletonList rows={3} />
        ) : list.length === 0 ? (
          <EmptyState
            title={t.tabs.noGroups}
            body={t.tabs.noGroupsBody}
            action={<Button label={t.newGroup} onPress={() => router.push('/new-group')} />}
          />
        ) : (
          <View>
            <SectionHeader
              title={t.yourGroups}
              action={
                <Text variant="caption" tone="brand" onPress={() => router.push('/new-group')}>
                  {t.newGroup}
                </Text>
              }
            />
            <View style={{ gap: theme.spacing.lg }}>
              {list.map((group) => {
                const members = summary.membersFor(group.id);
                const balance = summary.balanceFor(group.id);
                // The other people in the group, for the avatar cluster — your
                // own face is the one at the top of the screen already.
                const others = members
                  .filter((member) => !member.left_at)
                  .filter((member) => !(member.profile_id && member.profile_id === profile?.id))
                  .map((member) => displayName(member, profile?.id));
                return (
                  <GroupCard
                    key={group.id}
                    id={group.id}
                    title={groupLabel(group, members, profile?.id)}
                    memberLabel={plural(locale, summary.memberCountFor(group.id), t.memberCount)}
                    memberNames={others}
                    coverEmoji={group.cover_emoji}
                    balance={balance}
                    currency={group.default_currency}
                    locale={locale}
                    statusLabel={
                      balance === 0n ? t.allSettled : balance > 0n ? t.youAreOwed : t.youOwe
                    }
                    pendingLabel={summary.hasPending(group.id) ? t.pendingConfirmation : null}
                    onPress={() => router.push(`/group/${group.id}`)}
                  />
                );
              })}
            </View>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
