import { useRef, useState } from 'react';
import type { ScrollView as RNScrollView } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import {
  Avatar,
  Badge,
  Button,
  Callout,
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
  SegmentedTabs,
  Text,
  useTheme,
  useScreenClearance,
} from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import { useAvatarUrl } from '@/components/ProfileAvatar';
import { MapPreview } from '@/components/MapPreview';
import { ExpenseReceipts } from '@/components/ExpenseReceipts';
import { ExpenseComments } from '@/components/ExpenseComments';
import { ExpenseHistory } from '@/components/ExpenseHistory';
import { OverflowMenu, type OverflowMenuItem } from '@/components/OverflowMenu';
import {
  memberLookup,
  useDeleteExpense,
  useExpenseImageEvents,
  useExpenseVersions,
  useGroup,
  useRestoreExpense,
} from '@/data/hooks';
import { expenseTitle } from '@/data/expenseTitle';
import { useBlockedUsers } from '@/data/blocked';
import { displayName, groupLabel, isBlockedMember, isGhost } from '@/data/types';
import { plural, useStrings, type UiStrings } from '@/i18n';
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

/** A member's avatar showing their real picture when they have one. The signing
 *  hook (`useAvatarUrl`) must run per row, so this is its own component rather
 *  than a call inside a `.map`. Falls back to initials — same as the comment
 *  thread below. */
function MemberAvatar({
  name,
  photo,
  ghost,
  size = 38,
}: {
  name: string;
  photo: string | null | undefined;
  ghost: boolean;
  size?: number;
}): React.JSX.Element {
  const url = useAvatarUrl(photo);
  return <Avatar name={name} photoUrl={url} ghost={ghost} size={size} />;
}

/** One labelled row of the bill's detail card — a muted label on the left, its
 *  value on the right. The stacked "paid by · date · split" caption the hero
 *  used to carry, given room to breathe as a proper key/value list. */
function DetailLine({ label, value }: { label: string; value: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Row
      style={{
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
      }}
    >
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="body" numberOfLines={1} style={{ flexShrink: 1, textAlign: 'right' }}>
        {value}
      </Text>
    </Row>
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
  const scrollRef = useRef<RNScrollView>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // The page has two faces: its breakdown, and its edit history. The hero stays
  // above both; only the body below the tab bar swaps.
  const [tab, setTab] = useState<'details' | 'history'>('details');
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
  // Whether *you* have any stake in this bill — money you put in, or a share you
  // owe of it. A member who is on the group but not on this split (or written into
  // it with a zero share) has no stake, so the screen frames itself as someone
  // else's bill: an observer banner up top, and the split shown in neutral ink
  // instead of the owe-red that would imply the debt is yours. This is money-only
  // on purpose — being the author but not a party still reads as not involved.
  const myPaidHere = version?.payers.find((p) => p.member_id === myMemberId)?.amount;
  const myShareHere = version?.shares.find((s) => s.member_id === myMemberId)?.amount;
  // Only classify once we know who the viewer is. An unresolved `myMemberId` (the
  // members mirror still hydrating, or a viewer with no membership row yet) would
  // otherwise read as zero-paid/zero-share and flash the "not involved" banner
  // over a bill the viewer may well be in. Null → leave it involved (no banner)
  // until resolution; a resolved member genuinely not in the split still gets the
  // zero-stake treatment.
  const notInvolved =
    Boolean(version) &&
    myMemberId !== null &&
    BigInt(myPaidHere ?? 0) === 0n &&
    BigInt(myShareHere ?? 0) === 0n;
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
  // The typed note. It also names the expense in the hero, but that heading is
  // clamped to a single line while the field is multiline — so a long or
  // multi-line note is only half-shown up top. Render the full text as a "Note"
  // row whenever the hero cannot have conveyed all of it (more than one line, or
  // longer than one fits), so nothing the author typed is lost on this screen.
  const note = (version.description ?? '').trim();
  // Roughly one line of the hero heading on a phone; past this the clamp bites.
  const HERO_TITLE_CLAMP = 30;
  const showNote = note !== '' && (note.includes('\n') || note.length > HERO_TITLE_CLAMP);
  // The hero is the dashboard/group panel: one saturated wash running edge to
  // edge under the status bar, white controls and amount on it. The expense
  // amount is a total that belongs to nobody — it is not owed or owned — so the
  // wash is the neutral brand indigo, never a money verdict. The category keeps
  // its own colour as the badge chip on the wash.

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

  // The bill's actions, gathered into the header's three-dot menu. A live bill
  // offers Edit and a red Delete; a deleted one offers only Restore, matching
  // Splitwise's deleted-transaction header. The mutations' pending flags disable
  // the row so a double-tap cannot fire twice.
  const menuItems: OverflowMenuItem[] = deleted
    ? [
        {
          icon: 'refresh',
          label: t.expense.restore,
          onPress: () => {
            if (!restoreExpense.isPending) restoreExpense.mutate(expense.id);
          },
        },
      ]
    : [
        {
          icon: 'create-outline',
          label: t.common.edit,
          onPress: () => router.push(`/group/${groupId}/add-expense?expenseId=${expense.id}`),
        },
        {
          icon: 'trash-outline',
          label: t.expense.deleteAction,
          tone: 'danger',
          onPress: () => {
            if (!deleteExpense.isPending) confirmDelete();
          },
        },
      ];

  return (
    <Screen edges={[]}>
      {/* The hero runs dark under the status bar, so its icons must be light —
          overriding the app's theme-driven default for this route. */}
      <StatusBar style="light" />
      {/* The expense hero, built like the group and dashboard panels: one
          saturated wash edge to edge and up under the status bar, carrying the
          back/edit controls, the category badge, the amount and its "paid by"
          line — all in white. Neutral brand indigo, never a money colour: the
          amount is a total that is nobody's balance. A fixed header: it sits as a
          sibling before the scroll so only the body below it scrolls, then re-pads
          and rounds only its bottom corners. */}
      <Gradient
        radius={0}
        colors={theme.gradient.brand}
        style={{
          paddingTop: insets.top + theme.spacing.md,
          paddingHorizontal: theme.spacing.xl,
          // Match the dashboard/group hero height: lg bottom padding, not xl.
          paddingBottom: theme.spacing.lg,
          borderBottomLeftRadius: theme.radius.xxl,
          borderBottomRightRadius: theme.radius.xxl,
          gap: theme.spacing.lg,
        }}
      >
        {/* A slim header bar, like the Friends hero: back and overflow on the
              ends, and the bill's identity held compactly between them — the
              category badge, the description as a one-line heading, the amount
              beneath it — instead of the tall stacked block, big display amount
              and receipt pill this hero used to be. Adding a receipt moved back
              into the receipts section's own tile below. */}
        <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
          {/* Back and overflow match the dashboard/group hero: a chip-less xxl
                white glyph, not the smaller boxed IconButton. */}
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
              color={theme.color.onBrand}
            />
          </Pressable>
          <CategoryBadge
            category={version.category}
            meta={version.category_meta}
            description={version.description}
            size={40}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
              <Text variant="subheading" tone="onBrand" numberOfLines={1} style={{ flex: 1 }}>
                {expenseTitle(version.description, version.category, t, version.category_meta)}
              </Text>
              {deleted ? <Badge label={t.expense.deleted} tone="negative" /> : null}
            </Row>
            {/* The amount kept in the hero, but at heading — not display — scale:
                  still the prominent number, no longer the reason the panel is
                  tall. Neutral white, never a money colour — it is a total, not a
                  balance. */}
            <MoneyText
              amount={BigInt(version.amount)}
              currency={currency}
              locale={locale}
              variant="title"
              style={{ color: theme.color.onBrand }}
            />
          </View>
          {/* Every action on this bill lives behind one three-dot menu, the same
                trailing control the group and dashboard headers carry — Edit and
                Delete (or Restore) instead of a full-width button stacked at the
                bottom of a long scroll. */}
          <Pressable
            onPress={() => setMenuOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t.group.more}
            hitSlop={10}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <Ionicons name="ellipsis-vertical" size={iconSize.xxl} color={theme.color.onBrand} />
          </Pressable>
        </Row>
      </Gradient>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          paddingTop: theme.spacing.xl,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
        // The comment composer lives at the very bottom; keep tapping its actions
        // working while the keyboard is up, and let iOS inset for the keyboard.
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {/* The two faces of the page — its breakdown and its edit history —
            sectioned so the audit is its own place rather than the tail of a
            long scroll. */}
        <SegmentedTabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'details', label: t.expense.detailsTab },
            { value: 'history', label: t.expense.history },
          ]}
        />

        {tab === 'history' ? (
          <ExpenseHistory
            versions={versions.data ?? []}
            imageEvents={imageEvents.data ?? []}
            nameOf={nameOf}
            t={t}
            locale={locale}
          />
        ) : (
          <>
            {/* You are looking at a bill you have no stake in — not a payer, no
            share. Say so plainly up top so the split below reads as someone
            else's ledger, the way Splitwise marks it "not involved" rather than
            letting a zero balance masquerade as "all settled". */}
            {notInvolved ? (
              <Callout
                tone="info"
                icon={(color) => <Ionicons name="eye-outline" size={iconSize.md} color={color} />}
                title={t.expense.notInvolvedTitle}
              >
                {t.expense.notInvolvedBody}
              </Callout>
            ) : null}

            {/* The bill's facts as a tidy labelled card — who paid, when, and how
                it was split — in place of the stacked caption and chips the hero
                used to wear. The group it belongs to leads the list so the bill
                is placed without crowding the hero. */}
            <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
              <DetailLine
                label={t.expense.detailGroup}
                value={groupLabel(group.data, members.data ?? [], profile?.id)}
              />
              <View style={{ height: 1, backgroundColor: theme.color.border }} />
              <DetailLine
                label={t.paidBy}
                value={
                  version.payers.length > 1
                    ? plural(locale, version.payers.length, t.misc.peopleCount)
                    : nameOf(version.payers[0]?.member_id ?? null)
                }
              />
              <View style={{ height: 1, backgroundColor: theme.color.border }} />
              <DetailLine
                label={t.expense.detailDate}
                value={new Intl.DateTimeFormat(locale, {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                  timeZone: 'UTC',
                }).format(new Date(version.expense_date))}
              />
              <View style={{ height: 1, backgroundColor: theme.color.border }} />
              <DetailLine
                label={t.expense.detailSplit}
                value={splitLabels(t)[version.split_type] ?? version.split_type}
              />
            </Card>

            {/* Receipts — one gallery, many images, each group-visible or private.
            Folds in the legacy single bill (E2) as its first item. Adding is now
            the hero button (externalAdd), driven through the ref; this section
            shows the gallery of what is already kept. */}
            <ExpenseReceipts
              groupId={groupId}
              expenseId={expense.id}
              canManage={isExpenseParty}
              canRemoveLegacy={isExpenseParty || iAmAdmin}
              legacyReceiptPath={receiptUri ? expenseReceiptPath(groupId, expense.id) : null}
              onLegacyRemoved={() => setReceiptUri(null)}
            />

            {/* The full note, when the clamped hero heading could not have shown
            all of it — a multi-line or long description is only half-visible up
            top, so it gets its own readable, wrapping row here. */}
            {showNote ? (
              <View>
                <SectionHeader title={t.expense.note} />
                <Card>
                  <Text variant="body">{note}</Text>
                </Card>
              </View>
            ) : null}

            {/* Where it happened (A43): a little map of the point, and a tap
            anywhere on the card opens it in the phone's maps app. Absent when
            the author attached no location. */}
            {location ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.location.openMap}
                onPress={() => void Linking.openURL(mapsUrl(location)).catch(() => undefined)}
              >
                <Card style={{ gap: theme.spacing.sm, padding: theme.spacing.sm }}>
                  <MapPreview location={location} accessibilityLabel={t.location.openMap} />
                  <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
                    <Ionicons name="location" size={iconSize.md} color={theme.color.brand} />
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
                            <MemberAvatar
                              name={avatarNameOf(payer.member_id)}
                              photo={payerMember?.profile?.avatar_url}
                              ghost={
                                payerMember
                                  ? isGhost(payerMember) || isBlockedMember(payerMember, blockedIds)
                                  : false
                              }
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
                          <MemberAvatar
                            name={avatarNameOf(share.member_id)}
                            photo={member?.profile?.avatar_url}
                            ghost={
                              member
                                ? isGhost(member) || isBlockedMember(member, blockedIds)
                                : false
                            }
                          />
                        }
                        trailing={
                          <MoneyText
                            amount={BigInt(share.amount)}
                            currency={currency}
                            locale={locale}
                            variant="caption"
                            // A share is money owed toward this bill, so it wears the
                            // same owe colour the balances do across the app — not the
                            // neutral ink of a total. Forced (not sign-derived): every
                            // share is a positive owe, so mode="balance" would read it
                            // as "owed to you" (green) instead. But when *you* are not
                            // in this split, none of these owes are yours to read as
                            // debt — the whole list drops to muted ink so it reads as
                            // someone else's ledger, matching the observer banner.
                            tone={notInvolved ? 'muted' : 'negative'}
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
                  avatarNameOf={avatarNameOf}
                  photoOf={(memberId) =>
                    memberId ? (lookup.get(memberId)?.profile?.avatar_url ?? null) : null
                  }
                />
              </Card>
            </View>

            {/* Edit and Delete moved up into the header's three-dot menu; the only
            note left here is the reassurance that an edit keeps every version. */}
            <Text variant="micro" tone="muted" align="center">
              {t.extras.nothingOverwritten}
            </Text>
          </>
        )}
      </ScrollView>

      <OverflowMenu visible={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems} />
    </Screen>
  );
}
