/**
 * The people you have blocked, and the one screen that still shows them by name.
 *
 * Everywhere else a blocked person is rendered as the anonymous ghost — that is
 * the whole point of blocking. Here they keep their real name and face, because
 * this is where you decide to let them back: you cannot unblock a row of
 * identical ghosts. Blocking is device-local and display-only (see
 * `data/blocked`); the note says so plainly, so nobody mistakes it for the kind
 * of block that hides you from them or splits a balance.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';

import {
  Avatar,
  Button,
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import type { BlockedUser } from '@/data/blocked';
import { useBlockedUsers } from '@/data/blocked';
import { useAvatarUrl } from '@/components/ProfileAvatar';
import { useStrings, type UiStrings } from '@/i18n';

export default function BlockedScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();
  const { blocked, unblock } = useBlockedUsers();

  return (
    <Screen>
      <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.lg}
            color={theme.color.text}
          />
        </IconButton>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="heading">{t.blocked.title}</Text>
        </View>
        <View style={{ width: 44 }} />
      </Row>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          paddingTop: theme.spacing.lg,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Text variant="caption" tone="muted">
          {t.blocked.note}
        </Text>

        {blocked.length === 0 ? (
          <EmptyState
            title={t.blocked.emptyTitle}
            body={t.blocked.emptyBody}
            icon={
              <Ionicons
                name="person-remove-outline"
                size={iconSize.xxl}
                color={theme.color.brand}
              />
            }
          />
        ) : (
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {blocked.map((user, index) => (
              <View key={user.id}>
                <BlockedRow user={user} onUnblock={() => unblock(user.id)} t={t} />
                {index < blocked.length - 1 ? (
                  <View style={{ height: 1, backgroundColor: theme.color.border }} />
                ) : null}
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}

/** One blocked person: their real name and face, and the way back in. */
function BlockedRow({
  user,
  onUnblock,
  t,
}: {
  user: BlockedUser;
  onUnblock: () => void;
  t: UiStrings;
}): React.JSX.Element {
  const theme = useTheme();
  const url = useAvatarUrl(user.avatarUrl);
  const name = user.name.trim() || t.misc.someone;

  return (
    <Row style={{ paddingVertical: theme.spacing.sm, alignItems: 'center', gap: theme.spacing.md }}>
      <Avatar name={name} size={44} photoUrl={url} />
      <Text variant="subheading" numberOfLines={1} style={{ flex: 1 }}>
        {name}
      </Text>
      <Button label={t.blocked.unblock} size="sm" variant="secondary" onPress={onUnblock} />
    </Row>
  );
}
