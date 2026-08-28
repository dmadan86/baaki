import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import {
  Avatar,
  directionalIcon,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  tintForKey,
  useTheme,
} from '@waves/ui';

import { useGroups, useHomeSummary } from '@/data/hooks';
import { groupLabel } from '@/data/types';
import { useAuth } from '@/lib/auth';
import { useFavorites } from '@/lib/favorites';
import { fill, plural, useStrings } from '@/i18n';

/**
 * Pick a group to start a new one from (the clone flow's front door).
 *
 * Everything about the chosen group — its name, icon, kind, dates, budget and
 * who is in it — is carried into the New Group screen as a starting point, where
 * it can all be changed and people dropped before anything is written. So this
 * screen only has to answer one question, "which one", and it answers it the way
 * the dashboard lists groups: a coloured avatar, the name, and who is in it.
 *
 * Favourites float to the top, because the group you duplicate every month is
 * the one you starred, and it should be the first thing under your thumb.
 */
export default function CloneGroupScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { profile } = useAuth();
  const groups = useGroups();
  const summary = useHomeSummary(profile?.id ?? null);
  const { isFavorite, toggle } = useFavorites();

  // Favourites first, then the app's existing group order underneath. Computed
  // each render rather than memoised: starring a group re-renders this screen
  // (the favourites store notifies it), and the sort should follow at once —
  // the group list is short, so the cost is nothing.
  const ordered = [...(groups.data ?? [])].sort(
    (a, b) => Number(isFavorite(b.id)) - Number(isFavorite(a.id)),
  );

  return (
    <Screen edges={['top', 'bottom']}>
      <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
        <IconButton label={t.common.close} onPress={() => router.back()}>
          <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
        </IconButton>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="heading">{t.clone.pickTitle}</Text>
        </View>
        <View style={{ width: 44 }} />
      </Row>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xl,
          gap: theme.spacing.xs,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Text variant="caption" tone="muted" style={{ paddingVertical: theme.spacing.md }}>
          {t.clone.pickIntro}
        </Text>

        {ordered.length === 0 ? (
          <Text tone="muted" style={{ paddingVertical: theme.spacing.xl, textAlign: 'center' }}>
            {t.clone.nothingToClone}
          </Text>
        ) : (
          ordered.map((group) => {
            const members = summary.membersFor(group.id);
            const title = groupLabel(group, members, profile?.id);
            const starred = isFavorite(group.id);
            return (
              <Pressable
                key={group.id}
                accessibilityRole="button"
                accessibilityLabel={fill(t.clone.startFrom, { name: title })}
                onPress={() => router.replace(`/new-group?from=${group.id}`)}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
              >
                <Row
                  style={{
                    gap: theme.spacing.md,
                    alignItems: 'center',
                    paddingVertical: theme.spacing.sm,
                  }}
                >
                  <Avatar
                    name={title}
                    emoji={group.cover_emoji ?? undefined}
                    size={48}
                    tint={tintForKey(group.id)}
                  />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="subheading" style={{ fontWeight: '600' }} numberOfLines={1}>
                      {title}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {plural(locale, summary.memberCountFor(group.id), t.memberCount)}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: starred }}
                    accessibilityLabel={
                      starred
                        ? fill(t.clone.unstar, { name: title })
                        : fill(t.clone.star, { name: title })
                    }
                    hitSlop={10}
                    onPress={() => toggle(group.id)}
                    style={({ pressed }) => ({
                      opacity: pressed ? 0.5 : 1,
                      padding: theme.spacing.xs,
                    })}
                  >
                    <Ionicons
                      name={starred ? 'star' : 'star-outline'}
                      size={iconSize.md}
                      color={starred ? theme.color.brand : theme.color.textFaint}
                    />
                  </Pressable>
                  <Ionicons
                    name={directionalIcon('chevron-forward')}
                    size={iconSize.base}
                    color={theme.color.textFaint}
                  />
                </Row>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}
