import { useRef, useState } from 'react';
import type { ScrollView as RNScrollView } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  Gradient,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
  useScreenClearance,
} from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import { ExpenseAttachments } from '@/components/ExpenseAttachments';
import { ExpenseComments } from '@/components/ExpenseComments';
import {
  memberLookup,
  useDeleteExpense,
  useExpenseImageEvents,
  useExpenseVersions,
  useGroup,
  useRemoveExpenseReceipt,
  useRestoreExpense,
  type ExpenseImageEventRow,
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

/** One line of the image audit — "{name} added the receipt", etc. */
function imageAuditLine(t: UiStrings, event: ExpenseImageEventRow, name: string): string {
  const template =
    event.kind === 'receipt'
      ? event.action === 'added'
        ? t.imageAudit.receiptAdded
        : t.imageAudit.receiptRemoved
      : event.action === 'added'
        ? t.imageAudit.attachmentAdded
        : t.imageAudit.attachmentRemoved;
  return fill(template, { name });
}

/** A small translucent-white pill for the meta tags on the hero wash (split
 *  type, "edited N times") — the on-panel equivalent of a Badge, legible on the
 *  saturated colour where a filled Badge would blend. */
function HeroTag({ label }: { label: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={{
        paddingVertical: 3,
        paddingHorizontal: theme.spacing.sm,
        borderRadius: theme.radius.pill,
        backgroundColor: 'rgba(255, 255, 255, 0.18)',
      }}
    >
      <Text variant="micro" tone="onBrand">
        {label}
      </Text>
    </View>
  );
}

export default function ExpenseDetailScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const { id, expenseId } = useLocalSearchParams<{ id: string; expenseId: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members, expenses } = useGroup(groupId);
  const versions = useExpenseVersions(expenseId ?? '');
  const imageEvents = useExpenseImageEvents(expenseId ?? '');
  const removeReceipt = useRemoveExpenseReceipt(groupId, expenseId ?? '');
  const scrollRef = useRef<RNScrollView>(null);
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
  // Admin of this group — the moderation lever on the comment thread (delete
  // anyone's, resolve a report). The server re-checks; this only shows controls.
  const iAmAdmin =
    (members.data ?? []).find((m) => m.profile_id === profile?.id && m.left_at === null)?.role ===
    'admin';
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
  // Only a party to the expense (a payer or the author) — or an admin — may
  // remove the kept bill, since the bill is evidence for the amount. The removal
  // is recorded in the image audit below, so a swap is never silent.
  const canManageReceipt = isExpenseParty || iAmAdmin;
  const confirmRemoveReceipt = (): void => {
    Alert.alert(t.imageAudit.removeReceiptConfirm, undefined, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.imageAudit.removeReceipt,
        style: 'destructive',
        onPress: () =>
          removeReceipt.mutate(undefined, {
            onSuccess: () => setReceiptUri(null),
            onError: () => Alert.alert(t.imageAudit.couldNotRemove),
          }),
      },
    ]);
  };
  // The hero is the dashboard/group panel: one saturated wash running edge to
  // edge under the status bar, white controls and amount on it. The expense
  // amount is a total that belongs to nobody — it is not owed or owned — so the
  // wash is the neutral brand indigo, never a money verdict. The category keeps
  // its own colour as the badge chip on the wash.

  // Bring the comment composer above the keyboard when it focuses: the thread is
  // the last thing on a long page, so without this the input opens under the
  // keyboard. A short delay lets the resized layout settle before scrolling.
  const scrollToComposer = (): void => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
  };

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
    <Screen edges={[]}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
        // The comment composer lives at the very bottom; keep tapping its actions
        // working while the keyboard is up, and let iOS inset for the keyboard.
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {/* The expense hero, built like the group and dashboard panels: one
            saturated wash edge to edge and up under the status bar, carrying the
            back/edit controls, the category badge, the amount and its "paid by"
            line — all in white. Neutral brand indigo, never a money colour: the
            amount is a total that is nobody's balance. Breaks out of the
            scroll's padding, then re-pads and rounds only its bottom corners. */}
        <Gradient
          radius={0}
          colors={theme.gradient.brand}
          style={{
            marginHorizontal: -theme.spacing.xl,
            paddingTop: insets.top + theme.spacing.md,
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: theme.spacing.xl,
            borderBottomLeftRadius: theme.radius.xxl,
            borderBottomRightRadius: theme.radius.xxl,
            gap: theme.spacing.lg,
          }}
        >
          <Row>
            <IconButton label={t.common.back} onPress={() => router.back()}>
              <Ionicons
                name={directionalIcon('chevron-back')}
                size={iconSize.lg}
                color={theme.color.onBrand}
              />
            </IconButton>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text variant="heading" tone="onBrand" numberOfLines={1}>
                {expenseTitle(version.description, version.category, t, version.category_meta)}
              </Text>
              <Text variant="micro" tone="onBrand" style={{ opacity: 0.85 }}>
                {groupLabel(group.data, members.data ?? [])}
              </Text>
            </View>
            <IconButton
              label={t.common.edit}
              onPress={() => router.push(`/group/${groupId}/add-expense?expenseId=${expense.id}`)}
            >
              <Ionicons name="create-outline" size={iconSize.md} color={theme.color.onBrand} />
            </IconButton>
          </Row>

          <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
            <CategoryBadge category={version.category} meta={version.category_meta} size={48} />
            <MoneyText
              amount={BigInt(version.amount)}
              currency={currency}
              locale={locale}
              variant="display"
              style={{ color: theme.color.onBrand }}
            />
            <Text variant="caption" tone="onBrand" style={{ opacity: 0.85 }}>
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
              <HeroTag label={splitLabels(t)[version.split_type] ?? version.split_type} />
              {version.version_no > 1 ? (
                <HeroTag label={plural(locale, version.version_no - 1, t.expense.editedTimes)} />
              ) : null}
              {deleted ? <Badge label={t.expense.deleted} tone="negative" /> : null}
            </Row>
          </View>
        </Gradient>

        {/* The bill, when there is one to see (E2). The thumbnail opens the
            pinch-zoom viewer; the image is served from R2 to any group member.
            Absent entirely when no bill was kept. */}
        {hasReceipt ? (
          <Card style={{ paddingVertical: theme.spacing.md }}>
            <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
              {/* The view tap is its own Pressable so the remove button beside it
                  is not swallowed by it (no nested-Pressable ambiguity). */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.expense.viewReceipt}
                onPress={openReceipt}
                style={({ pressed }) => ({
                  flex: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing.md,
                  minWidth: 0,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
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
              </Pressable>
              {canManageReceipt ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t.imageAudit.removeReceipt}
                  onPress={confirmRemoveReceipt}
                  disabled={removeReceipt.isPending}
                  hitSlop={10}
                  style={({ pressed }) => ({
                    padding: theme.spacing.xs,
                    opacity: removeReceipt.isPending ? 0.4 : pressed ? 0.5 : 1,
                  })}
                >
                  <Ionicons name="trash-outline" size={iconSize.md} color={theme.color.negative} />
                </Pressable>
              ) : null}
            </Row>
          </Card>
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

        {/* The image audit (A46): who added or removed a receipt or an attachment,
            oldest first. A `parties` line only reaches a party's device (RLS on
            the pull), so anyone who sees a line here was allowed to. Absent until
            something happens to an image. */}
        {(imageEvents.data ?? []).length > 0 ? (
          <View>
            <SectionHeader title={t.imageAudit.title} />
            <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
              {(imageEvents.data ?? []).map((event, index, arr) => (
                <View key={event.id}>
                  <ListRow
                    title={imageAuditLine(t, event, nameOf(event.actorMemberId))}
                    subtitle={
                      event.createdAt
                        ? new Intl.DateTimeFormat(locale, {
                            day: 'numeric',
                            month: 'short',
                            hour: 'numeric',
                            minute: '2-digit',
                          }).format(new Date(event.createdAt))
                        : undefined
                    }
                    leading={
                      <Avatar
                        name={nameOf(event.actorMemberId)}
                        emoji={event.action === 'added' ? '📎' : '🗑️'}
                        size={38}
                      />
                    }
                    trailing={
                      event.visibility === 'parties' ? (
                        <Badge label={t.imageAudit.partyOnly} tone="neutral" />
                      ) : undefined
                    }
                  />
                  {index < arr.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: theme.color.border }} />
                  ) : null}
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        {/* The thread on this bill. Any member reads and adds; the author edits
            and deletes their own; an admin deletes anyone's and resolves reports.
            The controls the component offers mirror what the RPCs allow. */}
        <View>
          <SectionHeader title={t.comments.title} />
          <Card>
            <ExpenseComments
              groupId={groupId}
              expenseId={expense.id}
              myMemberId={myMemberId}
              iAmAdmin={iAmAdmin}
              nameOf={nameOf}
              onComposerFocus={scrollToComposer}
            />
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
