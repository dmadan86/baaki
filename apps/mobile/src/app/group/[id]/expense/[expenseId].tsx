import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
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
import { receiptFiles } from '@/lib/receiptStore';

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
  const lookup = memberLookup(members.data);
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

  // The bill (E2/E3). The owner has it in the device vault; a member who is not
  // the owner has no local copy, but may have the owner's Drive link if they
  // opened it to the group. Either is a way to see the receipt — the local one
  // opens the in-app zoom viewer, the link opens the owner's own Drive.
  const localReceipt = receiptFiles(expense.id);
  const receiptShareUrl = version.receipt_share_url;
  const hasReceipt = Boolean(localReceipt) || Boolean(receiptShareUrl);
  const openReceipt = (): void => {
    if (localReceipt) {
      router.push(
        `/receipt/${expense.id}${
          receiptShareUrl ? `?shareUrl=${encodeURIComponent(receiptShareUrl)}` : ''
        }`,
      );
    } else if (receiptShareUrl) {
      void Linking.openURL(receiptShareUrl).catch(() => undefined);
    }
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

        {/* The bill, when there is one to see (E2/E3). A local thumbnail opens
            the pinch-zoom viewer; a member with only the owner's share link gets
            a row that opens it. Absent entirely when neither exists. */}
        {hasReceipt ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.expense.viewReceipt}
            onPress={openReceipt}
          >
            <Card style={{ paddingVertical: theme.spacing.md }}>
              <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
                {localReceipt ? (
                  <Image
                    source={{ uri: localReceipt.imageUri }}
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
