import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';

import {
  directionalIcon,
  EmptyState,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import { useGroups, useHomeSummary } from '@/data/hooks';
import { groupLabel } from '@/data/types';
import { plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { SkeletonList } from '@/components/Skeletons';

/**
 * The full, browsable list of every group — the "All groups" door off the
 * dashboard's capped preview. Built in the Activity feed's shape: a plain
 * hairline-divided list of soft-tile rows, not the dashboard's single card,
 * so a long roster reads the same skimmable way the activity timeline does.
 */
export default function AllGroupsScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const { profile } = useAuth();
  const summary = useHomeSummary(profile?.id ?? null);
  const groups = useGroups();
  const list = groups.data ?? [];
  const loading = groups.isLoading || summary.isLoading;

  const header = (
    <Row style={{ paddingTop: theme.spacing.md, alignItems: 'center', gap: theme.spacing.sm }}>
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel={t.common.back}
        hitSlop={10}
        style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
      >
        <Ionicons
          name={directionalIcon('chevron-back')}
          size={iconSize.xxl}
          color={theme.color.text}
        />
      </Pressable>
      <Text variant="title">{t.allGroups}</Text>
    </Row>
  );

  return (
    <Screen>
      <FlashList
        data={list}
        keyExtractor={(group) => group.id}
        // Render ahead of the viewport so a fast fling doesn't flash blank rows.
        drawDistance={800}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
        }}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={header}
        ListEmptyComponent={
          loading ? (
            <View style={{ paddingTop: theme.spacing.xl }}>
              <SkeletonList rows={5} />
            </View>
          ) : (
            <View style={{ paddingTop: theme.spacing.xxxl }}>
              <EmptyState
                title={t.tabs.noGroups}
                icon={
                  <Ionicons name="people-outline" size={iconSize.xxl} color={theme.color.brand} />
                }
              />
            </View>
          )
        }
        ItemSeparatorComponent={() => (
          <View style={{ height: 1, backgroundColor: theme.color.border }} />
        )}
        renderItem={({ item: group }) => {
          const members = summary.membersFor(group.id);
          const balance = summary.balanceFor(group.id);
          const pending = summary.hasPending(group.id);
          const statusLabel =
            balance === 0n ? t.allSettled : balance > 0n ? t.youAreOwed : t.youOwe;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${groupLabel(group, members, profile?.id)}. ${statusLabel}`}
              onPress={() => router.push(`/group/${group.id}`)}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Row
                style={{
                  gap: theme.spacing.md,
                  alignItems: 'center',
                  paddingVertical: theme.spacing.sm,
                }}
              >
                <View
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: theme.color.surfaceMuted,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 20 }}>{group.cover_emoji ?? '👥'}</Text>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text
                    variant="body"
                    numberOfLines={1}
                    style={{ flexShrink: 1, fontWeight: '600' }}
                  >
                    {groupLabel(group, members, profile?.id)}
                  </Text>
                  <Text variant="caption" tone="muted" numberOfLines={1}>
                    {pending
                      ? t.pendingConfirmation
                      : `${plural(locale, summary.memberCountFor(group.id), t.memberCount)} · ${statusLabel}`}
                  </Text>
                </View>
                <MoneyText
                  amount={balance}
                  currency={group.default_currency as never}
                  locale={locale}
                  mode="balance"
                  variant="subheading"
                />
              </Row>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}
