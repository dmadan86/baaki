import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, View } from 'react-native';

import { resolveCategory } from '@waves/core';
import {
  Avatar,
  Badge,
  Button,
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  TintCard,
  useTheme,
  useScreenClearance,
} from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import { TripAlbumStrip } from '@/components/TripAlbum';
import { ExpenseAttachments } from '@/components/ExpenseAttachments';
import {
  memberLookup,
  useDeleteExpense,
  useExpenseVersions,
  useGroup,
  useRestoreExpense,
} from '@/data/hooks';
import { expenseTitle } from '@/data/expenseTitle';
import { useBlockedUsers } from '@/data/blocked';
import { displayName, groupLabel, isBlockedMember, isGhost } from '@/data/types';
import { fill, plural, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { expenseReceiptPath, expenseReceiptUrl } from '@/data/api';
import { coordLabel, mapsUrl } from '@/lib/location';

function splitLabels(t: UiStrings): Record<string, string> {
  return {
    equal: t.expense.splitEqually,
    exact: t.expense.exactAmounts,
    percent: t.expense.byPercentage,
    shares: t.expense.byShares,
    adjustment: t.expense.withAdjustments,
    itemized: t.expense.itemized,
  };
}

export default function ExpenseDetailScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const { id, expenseId } = useLocalSearchParams<{ id: string; expenseId: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members, expenses } = useGroup(groupId);
  const versions = useExpenseVersions(expenseId ?? '');
  const deleteExpense = useDeleteExpense(groupId);
  const restoreExpense = useRestoreExpense(groupId);

  const expense = expenses.rows.find((row) => row.id === expenseId);
  const version = expense?.currentVersion;
  const { blockedIds } = useBlockedUsers();

  // The kept bill (E2), resolved from R2. `expenseReceiptUrl` doubles as the
  // existence check — it returns null when no bill was ever kept — so a URL here
  // both proves the receipt exists and gives the thumbnail something to show. A
  // group receipt in R2 is group-readable, so any member sees it, not just the
  // author. Absent on web/anonymous where storage does not resolve, which reads
  // as "no receipt" and simply hides the row.
  const [receiptUri, setReceiptUri] = useState<string | null>(null);
  const currentExpenseId = expense?.id;
  // Re-resolve on focus, not only when the ids change: a bill kept on the edit
  // screen (which uploads on save) is not in R2 when this screen first mounts, so
  // resolving again on the way back is what reveals the receipt row.
  // Inline, not wrapped in useCallback: this app compiles with React Compiler
  // (`reactCompiler: true`), which auto-memoises the callback — and actively
  // rejects a hand-written useCallback here ("existing memoization could not be
  // preserved"). So the focus effect does not re-run every render.
  useFocusEffect(() => {
    if (!currentExpenseId) return undefined;
    let active = true;
    // Keep the last good URL on a failed refresh: `expenseReceiptUrl` returns
    // null for both "no receipt" and a transient signing failure, and a receipt
    // that was showing should not vanish just because one refresh could not sign
    // it. A first resolve starts from null, so a real absence still reads as none.
    expenseReceiptUrl(groupId, currentExpenseId).then((url) => {
      if (active) setReceiptUri((prev) => url ?? prev);
    });
    return () => {
      active = false;
    };
  });
  const lookup = memberLookup(members.data);
  // A party to this expense — a payer of the current version, or its author — is
  // the only one who may attach to it (the RPC enforces this too). Non-parties
  // still SEE any group-visible attachment; they just cannot add or see a private
  // one. Computed from the mirror; the server is the real gate.
  const myMemberId =
    (members.data ?? []).find((m) => m.profile_id === profile?.id && m.left_at === null)?.id ??
    null;
  const isExpenseParty = Boolean(
    myMemberId &&
    version &&
    (version.author_member_id === myMemberId ||
      version.payers.some((p) => p.member_id === myMemberId)),
  );
  const nameOf = (memberId: string | null): string => {
    const member = memberId ? lookup.get(memberId) : undefined;
    return member ? displayName(member, profile?.id, blockedIds, t.misc.someone) : t.misc.someone;
  };
  // The label reads "You"; the avatar keeps the real name so the current user's
  // circle is the same initial and colour here as on every other screen — a
  // balances row keys the avatar off the real name too. Passing "You" to the
  // avatar made it a lone pink "Y" next to a blue "G" elsewhere for one person.
  const avatarNameOf = (memberId: string | null): string => {
    const member = memberId ? lookup.get(memberId) : undefined;
    return member ? displayName(member, null, blockedIds, t.misc.someone) : t.misc.someone;
  };

  if (expenses.isLoading) {
    // Shell first: the back button paints instantly on navigation; the title
    // and body fill in once the mirror read lands (a few ms at launch).
    return (
      <Screen>
        <View style={{ paddingHorizontal: theme.spacing.xl }}>
          <Row style={{ paddingTop: theme.spacing.md }}>
            <IconButton label={t.common.back} onPress={() => router.back()}>
              <Ionicons
                name={directionalIcon('chevron-back')}
                size={iconSize.lg}
                color={theme.color.text}
              />
            </IconButton>
            <View style={{ flex: 1 }} />
            <View style={{ width: 44 }} />
          </Row>
          <View style={{ paddingTop: theme.spacing.xxxl, alignItems: 'center' }}>
            <ActivityIndicator color={theme.color.brand} />
          </View>
        </View>
      </Screen>
    );
  }

  if (!expense || !version) {
    return (
      <Screen>
        <EmptyState
          title={t.expense.notFound}
          body={t.expense.notFoundBody}
          action={<Button label={t.common.back} onPress={() => router.back()} />}
        />
      </Screen>
    );
  }

  const currency = version.currency;
  const deleted = Boolean(expense.deleted_at);

  // Where it happened (A43), when the author attached one. A plain snapshot — a
  // tap opens the point in the phone's maps app.
  const location = version.location;
  const hasReceipt = Boolean(receiptUri);
  const openReceipt = (): void => {
    router.push(
      `/receipt/${expense.id}?path=${encodeURIComponent(expenseReceiptPath(groupId, expense.id))}`,
    );
  };
  // The hero wears the expense's category colour, not a money colour: this
  // amount is a total that belongs to nobody, shown neutral. Ink from the same
  // pair keeps it legible on the tint.
  const heroTint = resolveCategory(version.category, version.category_meta).tint;
  const heroInk = theme.tint[heroTint].ink;
  const heroInkMuted = theme.tint[heroTint].inkMuted;

  const confirmDelete = (): void => {
    Alert.alert(t.expense.deleteQuestion, t.expense.deleteBody, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.delete,
        style: 'destructive',
        onPress: () => {
          deleteExpense.mutate(expense.id, { onSuccess: () => router.back() });
        },
      },
    ]);
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
            <Text variant="heading" numberOfLines={1}>
              {expenseTitle(version.description, version.category, t, version.category_meta)}
            </Text>
            <Text variant="micro" tone="muted">
              {groupLabel(group.data, members.data ?? [])}
            </Text>
          </View>
          <IconButton
            label={t.common.edit}
            onPress={() => router.push(`/group/${groupId}/add-expense?expenseId=${expense.id}`)}
          >
            <Ionicons name="create-outline" size={iconSize.md} color={theme.color.text} />
          </IconButton>
        </Row>

        <TintCard
          tint={heroTint}
          style={{
            alignItems: 'center',
            gap: theme.spacing.sm,
            borderRadius: theme.radius.xl,
            padding: theme.spacing.xl,
          }}
        >
          <CategoryBadge category={version.category} meta={version.category_meta} size={48} />
          <MoneyText
            amount={BigInt(version.amount)}
            currency={currency}
            locale={locale}
            variant="display"
            style={{ color: heroInk }}
          />
          <Text variant="caption" style={{ color: heroInkMuted }}>
            {`${fill(t.expense.paidByName, {
              name: nameOf(version.payers[0]?.member_id ?? null),
            })} · ${new Intl.DateTimeFormat(locale, {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              timeZone: 'UTC',
            }).format(new Date(version.expense_date))}`}
          </Text>
          <Row style={{ gap: theme.spacing.sm }}>
            <Badge label={splitLabels(t)[version.split_type] ?? version.split_type} tone="brand" />
            {version.version_no > 1 ? (
              <Badge label={plural(locale, version.version_no - 1, t.expense.editedTimes)} />
            ) : null}
            {deleted ? <Badge label={t.expense.deleted} tone="negative" /> : null}
          </Row>
        </TintCard>

        {/* The bill, when there is one to see (E2). The thumbnail opens the
            pinch-zoom viewer; the image is served from R2 to any group member.
            Absent entirely when no bill was kept. */}
        {hasReceipt ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.expense.viewReceipt}
            onPress={openReceipt}
          >
            <Card style={{ paddingVertical: theme.spacing.md }}>
              <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
                {receiptUri ? (
                  <Image
                    source={{ uri: receiptUri }}
                    style={{ width: 52, height: 52, borderRadius: theme.radius.md }}
                    contentFit="cover"
                    transition={150}
                  />
                ) : (
                  <View
                    style={{
                      width: 52,
                      height: 52,
                      borderRadius: theme.radius.md,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: theme.color.bg,
                    }}
                  >
                    <Ionicons name="receipt-outline" size={iconSize.lg} color={theme.color.brand} />
                  </View>
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text variant="subheading" numberOfLines={1}>
                    {t.expense.viewReceipt}
                  </Text>
                  <Text variant="micro" tone="muted" numberOfLines={1}>
                    {t.expense.receiptTitle}
                  </Text>
                </View>
                <Ionicons
                  name={directionalIcon('chevron-forward')}
                  size={iconSize.md}
                  color={theme.color.textFaint}
                />
              </Row>
            </Card>
          </Pressable>
        ) : null}

        {/* Where it happened (A43). A tap opens the point in the phone's maps
            app; absent when the author attached no location. */}
        {location ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.location.openMap}
            onPress={() => void Linking.openURL(mapsUrl(location)).catch(() => undefined)}
          >
            <Card style={{ paddingVertical: theme.spacing.md }}>
              <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
                <View
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: theme.radius.md,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: theme.color.bg,
                  }}
                >
                  <Ionicons name="location" size={iconSize.lg} color={theme.color.brand} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text variant="subheading" numberOfLines={1}>
                    {location.name?.trim() || coordLabel(location)}
                  </Text>
                  <Text variant="micro" tone="muted" numberOfLines={1}>
                    {t.location.openMap}
                  </Text>
                </View>
                <Ionicons
                  name={directionalIcon('chevron-forward')}
                  size={iconSize.md}
                  color={theme.color.textFaint}
                />
              </Row>
            </Card>
          </Pressable>
        ) : null}

        {/* The album strip for this bill — photos of the meal, the room, the view.
            Distinct from the receipt above: many, free, and browsed for the memory
            rather than the amount. */}
        <TripAlbumStrip groupId={groupId} expenseId={expense.id} />

        {/* Attachments — images at a chosen visibility. `group` is like the
            receipt; `parties` is hidden to everyone but this bill's payers +
            author (§3, private attachments). */}
        <ExpenseAttachments groupId={groupId} expenseId={expense.id} canAttach={isExpenseParty} />

        {version.payers.length > 1 ? (
          <View>
            <SectionHeader title={t.paidBy} />
            <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
              {version.payers.map((payer, index) => {
                const payerMember = lookup.get(payer.member_id);
                return (
                  <View key={payer.member_id}>
                    <ListRow
                      title={nameOf(payer.member_id)}
                      leading={
                        <Avatar
                          name={avatarNameOf(payer.member_id)}
                          ghost={
                            payerMember
                              ? isGhost(payerMember) || isBlockedMember(payerMember, blockedIds)
                              : false
                          }
                          size={38}
                        />
                      }
                      trailing={
                        <MoneyText
                          amount={BigInt(payer.amount)}
                          currency={currency}
                          locale={locale}
                          variant="caption"
                        />
                      }
                    />
                    {index < version.payers.length - 1 ? (
                      <View style={{ height: 1, backgroundColor: theme.color.border }} />
                    ) : null}
                  </View>
                );
              })}
            </Card>
          </View>
        ) : null}

        <View>
          <SectionHeader title={t.expense.whoOwesWhat} />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {version.shares.map((share, index) => {
              const member = lookup.get(share.member_id);
              return (
                <View key={share.member_id}>
                  <ListRow
                    title={nameOf(share.member_id)}
                    subtitle={member && isGhost(member) ? t.notJoinedYet : undefined}
                    leading={
                      <Avatar
                        name={avatarNameOf(share.member_id)}
                        ghost={
                          member ? isGhost(member) || isBlockedMember(member, blockedIds) : false
                        }
                        size={38}
                      />
                    }
                    trailing={
                      <MoneyText
                        amount={BigInt(share.amount)}
                        currency={currency}
                        locale={locale}
                        variant="caption"
                      />
                    }
                  />
                  {index < version.shares.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: theme.color.border }} />
                  ) : null}
                </View>
              );
            })}
          </Card>
        </View>

        {/* ADR-004: every edit is kept, and the group can see what changed. */}
        <View>
          <SectionHeader title={t.expense.history} />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {(versions.data ?? []).map((entry, index) => (
              <View key={entry.id}>
                <ListRow
                  title={entry.description}
                  subtitle={`v${entry.version_no} · ${nameOf(entry.author_member_id)} · ${new Intl.DateTimeFormat(
                    locale,
                    { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' },
                  ).format(new Date(entry.created_at))}`}
                  leading={
                    <Avatar
                      name={`v${entry.version_no}`}
                      emoji={entry.version_no === 1 ? '🧾' : '✏️'}
                      size={38}
                    />
                  }
                  trailing={
                    <MoneyText
                      amount={BigInt(entry.amount)}
                      currency={entry.currency}
                      locale={locale}
                      variant="caption"
                    />
                  }
                />
                {index < (versions.data?.length ?? 0) - 1 ? (
                  <View style={{ height: 1, backgroundColor: theme.color.border }} />
                ) : null}
              </View>
            ))}
          </Card>
        </View>

        {deleted ? (
          <Button
            label={t.expense.restore}
            size="lg"
            fullWidth
            disabled={restoreExpense.isPending}
            onPress={() => restoreExpense.mutate(expense.id)}
          />
        ) : (
          <Button
            label={t.expense.deleteAction}
            variant="ghost"
            size="lg"
            fullWidth
            disabled={deleteExpense.isPending}
            onPress={confirmDelete}
          />
        )}

        <Text variant="micro" tone="muted" align="center">
          {t.extras.nothingOverwritten}
        </Text>
      </ScrollView>
    </Screen>
  );
}
