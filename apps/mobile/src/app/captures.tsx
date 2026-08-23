/**
 * The capture inbox: expenses caught before they had a group (A34).
 *
 * Each row is a spend the user pinned for later — an amount, maybe a note and a
 * photo of the bill — waiting to be assigned to a group. Assigning opens the
 * ordinary add-expense form prefilled; saving there turns the capture into a
 * real group expense and drops it from this list. Everything here is personal
 * and offline-first: a row still queued shows a "not synced yet" hint rather
 * than hiding until the server has seen it (ADR-005).
 */

import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Alert, Modal, Pressable, RefreshControl, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Avatar,
  Badge,
  Button,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  tintForKey,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import { InboxSkeleton } from '@/components/Skeletons';
import { capturePhotoUrl } from '@/data/api';
import { useSignedUrl } from '@/lib/useSignedUrl';
import { dayHeading, groupByDay } from '@/data/activity';
import { useCaptures, useDeleteCapture, useGroups, useHomeSummary } from '@/data/hooks';
import { groupLabel, type CaptureRow, type GroupRow } from '@/data/types';
import { plural, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { usePullRefresh } from '@/lib/pullRefresh';

/**
 * `YYYY-MM-DD` shown short, parsed at local noon rather than midnight — a
 * date-only string read as midnight UTC lands on the day before west of
 * Greenwich (the trap TripDates already dodges).
 */
function shortDate(iso: string, locale: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year ?? 2026, (month ?? 1) - 1, day ?? 1, 12).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
  });
}

/** A signed URL for a capture's receipt, re-resolved on change and kept fresh
 *  past the signed-URL expiry (see `useSignedUrl`). */
function CaptureThumb({ path, size }: { path: string; size: number }) {
  const theme = useTheme();
  const url = useSignedUrl(path, capturePhotoUrl);

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: theme.radius.sm,
        overflow: 'hidden',
        backgroundColor: theme.color.surfaceMuted,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {url ? (
        <Image source={{ uri: url }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
      ) : (
        <Ionicons name="receipt-outline" size={size * 0.4} color={theme.color.textFaint} />
      )}
    </View>
  );
}

/**
 * One capture as a flat list row, the WhatsApp/GroupCard grammar the rest of the
 * app speaks: a leading identity glyph (the bill's own thumbnail, or its category
 * colour), the note over a muted date line, and the amount at the trailing edge.
 *
 * The whole row taps to assign — the one thing you do with a capture — so the
 * screen sheds the full-width button it used to stack under every card. Delete
 * is the quiet trailing control, kept out of the tap target by its own hitbox.
 */
function CaptureListRow({
  capture,
  locale,
  t,
  onAssign,
  onDelete,
}: {
  capture: CaptureRow;
  locale: string;
  t: UiStrings;
  onAssign: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  // The note names the spend; with none, its category does; with neither, it is
  // simply still unassigned. The amount always sits at the trailing edge, so the
  // title never has to carry it.
  const categoryLabel = capture.category
    ? (t.categories as Record<string, string>)[capture.category]
    : undefined;
  const title = capture.description?.trim() || categoryLabel || t.captures.unassigned;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${t.captures.assign}`}
      onPress={onAssign}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Row
        style={{ gap: theme.spacing.md, alignItems: 'center', paddingVertical: theme.spacing.md }}
      >
        {capture.photo_path ? (
          <CaptureThumb path={capture.photo_path} size={46} />
        ) : (
          <CategoryBadge category={capture.category} size={46} />
        )}

        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="subheading" numberOfLines={1}>
            {title}
          </Text>
          <Row style={{ gap: theme.spacing.xs, alignItems: 'center', marginTop: 2 }}>
            <Text variant="micro" tone="muted">
              {shortDate(capture.expense_date, locale)}
            </Text>
            {capture.pending ? <Badge label={t.captures.notSynced} tone="brand" /> : null}
          </Row>
        </View>

        <MoneyText
          amount={BigInt(capture.amount)}
          currency={capture.currency}
          locale={locale}
          variant="subheading"
        />
        <IconButton label={t.captures.delete} onPress={onDelete}>
          <Ionicons name="trash-outline" size={iconSize.md} color={theme.color.textFaint} />
        </IconButton>
      </Row>
    </Pressable>
  );
}

export default function CapturesScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const insets = useSafeAreaInsets();
  const { t, locale } = useStrings();
  const pull = usePullRefresh();
  const { profile } = useAuth();

  const captures = useCaptures();
  const deleteCapture = useDeleteCapture();
  const groups = useGroups();
  const summary = useHomeSummary(profile?.id ?? null);

  // Which capture is being assigned, if any — drives the group-picker sheet.
  const [assigning, setAssigning] = useState<CaptureRow | null>(null);
  // The picker's own search text, so a long group list stays one tap from any
  // group. Cleared whenever the sheet opens on a fresh capture.
  const [query, setQuery] = useState('');

  // Only groups the viewer still belongs to belong in the picker. Leaving a
  // group sets `left_at`; it does not remove the group row, so a left (or
  // owner-removed) group lingers in the local mirror and `useGroups` still
  // returns it. `membersFor` lists active members only, so a group where the
  // viewer is no longer among them is one they left — never an assignment
  // target for a new expense.
  const assignableGroups = useMemo(
    () =>
      (groups.data ?? []).filter((group) =>
        summary.membersFor(group.id).some((member) => member.profile_id === profile?.id),
      ),
    [groups.data, summary, profile?.id],
  );

  // Group rows matching the picker's search text, by name. Only worth showing a
  // search field once the list is long enough to scroll (below); until then the
  // memo just passes every group through.
  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return assignableGroups;
    return assignableGroups.filter((group) =>
      groupLabel(group, summary.membersFor(group.id), profile?.id).toLowerCase().includes(needle),
    );
  }, [assignableGroups, query, summary, profile?.id]);

  // Past this many groups the picker earns a search field; a short list is
  // faster to eyeball than to type through.
  const showSearch = assignableGroups.length > 6;

  const rows = captures.data ?? [];

  const openAssign = (capture: CaptureRow): void => {
    setQuery('');
    setAssigning(capture);
  };

  const closeAssign = (): void => {
    setAssigning(null);
    setQuery('');
  };

  // Hand the capture's own values to the add-expense form as prefill, and carry
  // its id so that saving there can close the capture (useAssignCapture). The
  // amount travels as the same minor-unit string the row stores.
  const assignTo = (capture: CaptureRow, group: GroupRow): void => {
    closeAssign();
    router.push({
      pathname: '/group/[id]/add-expense',
      params: {
        id: group.id,
        captureId: capture.id,
        amount: capture.amount,
        description: capture.description,
        category: capture.category ?? '',
        expenseDate: capture.expense_date,
      },
    });
  };

  return (
    <Screen edges={['top', 'bottom']}>
      {/* The glyph-plus-big-title mark the Activity and Inbox screens wear, so
          this reads as the sibling it is — the tray icon ties it to the Inbox
          family. Captures is pushed (not a bar destination), so it keeps a back
          chevron the tab screens don't need; the add stays at the trailing edge. */}
      <Row
        style={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.md,
          alignItems: 'center',
          gap: theme.spacing.sm,
        }}
      >
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.lg}
            color={theme.color.text}
          />
        </IconButton>
        <Ionicons name="file-tray-full-outline" size={iconSize.xl} color={theme.color.brand} />
        <Text variant="title" style={{ flex: 1 }}>
          {t.captures.title}
        </Text>
        <IconButton label={t.captures.captureCta} onPress={() => router.push('/capture')}>
          <Ionicons name="add" size={iconSize.xxl} color={theme.color.brand} />
        </IconButton>
      </Row>

      {/* One scroll region for every state, the way `ActivityScreen` does it —
          so pull-to-refresh still works while the mirror is loading or the
          inbox is genuinely empty, not only once cards are on screen. */}
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={theme.color.brand}
          />
        }
      >
        {captures.isLoading ? (
          <InboxSkeleton />
        ) : rows.length === 0 ? (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
              title={t.captures.emptyTitle}
              body={t.captures.emptyBody}
              action={
                <Button label={t.captures.captureCta} onPress={() => router.push('/capture')} />
              }
            />
          </View>
        ) : (
          // Day-grouped, same as the activity feed: an uppercase heading per
          // calendar day, then that day's captures as flat tappable rows — the
          // WhatsApp/GroupCard grammar the rest of the app uses, not the chunky
          // action-cards this screen used to stack. The whole row taps to assign
          // (the primary act on a capture); delete sits as a quiet trailing
          // control, the way the app carries secondary row actions.
          <View style={{ gap: theme.spacing.lg }}>
            {groupByDay(rows).map((section) => (
              <View key={section.key}>
                <Text
                  variant="micro"
                  tone="muted"
                  style={{ textTransform: 'uppercase', marginBottom: theme.spacing.xs }}
                >
                  {dayHeading(locale, section.entries[0]!.created_at)}
                </Text>
                {section.entries.map((capture) => (
                  <CaptureListRow
                    key={capture.id}
                    capture={capture}
                    locale={locale}
                    t={t}
                    onAssign={() => openAssign(capture)}
                    onDelete={() =>
                      Alert.alert(t.captures.delete, t.captures.deleteConfirm, [
                        { text: t.common.cancel, style: 'cancel' },
                        {
                          text: t.captures.delete,
                          style: 'destructive',
                          onPress: () => void deleteCapture.mutateAsync(capture.id),
                        },
                      ])
                    }
                  />
                ))}
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* The group picker, as a sheet over the list rather than a screen away —
          assigning is one tap and one choice, and a whole route for it would be
          a scroll and a back button around a short list.

          A real Modal, not an absolute overlay: the one bottom bar (`AppTabBar`)
          is rendered at the root over the whole stack, so an in-tree overlay
          paints *under* it and the sheet's lower rows hide behind the nav bar.
          A Modal floats above everything, the way the other sheets do. */}
      <Modal
        transparent
        visible={assigning !== null}
        animationType="fade"
        onRequestClose={closeAssign}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.common.close}
          onPress={closeAssign}
          style={{
            flex: 1,
            backgroundColor: 'rgba(10, 10, 26, 0.55)',
            justifyContent: 'flex-end',
          }}
        >
          <Pressable
            // Swallow taps on the sheet itself; only the backdrop dismisses.
            onPress={() => {}}
            accessibilityViewIsModal
            style={{
              backgroundColor: theme.color.surface,
              borderTopLeftRadius: theme.radius.xxl,
              borderTopRightRadius: theme.radius.xxl,
              paddingHorizontal: theme.spacing.xl,
              paddingTop: theme.spacing.md,
              // Clear the Android gesture/nav bar so the last group row is not
              // hidden behind it.
              paddingBottom: theme.spacing.md + insets.bottom,
              gap: theme.spacing.md,
              maxHeight: '80%',
              ...theme.shadow.lifted,
            }}
          >
            {/* The grab handle — the visual grammar of a sheet you can pull down,
                the same one every other sheet in the app wears. */}
            <View
              style={{
                alignSelf: 'center',
                width: 40,
                height: 4,
                borderRadius: 2,
                backgroundColor: theme.color.border,
                marginBottom: theme.spacing.xs,
              }}
            />

            <Text variant="heading">{t.captures.assignTitle}</Text>

            {/* What is being placed, so the sheet stands on its own over the
                list it hides: the amount and its note beside the capture's own
                glyph. */}
            {assigning ? (
              <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
                <CategoryBadge category={assigning.category} size={38} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <MoneyText
                    amount={BigInt(assigning.amount)}
                    currency={assigning.currency}
                    locale={locale}
                    variant="subheading"
                  />
                  {assigning.description ? (
                    <Text variant="caption" tone="muted" numberOfLines={1}>
                      {assigning.description}
                    </Text>
                  ) : null}
                </View>
              </Row>
            ) : null}

            <Text variant="caption" tone="muted">
              {t.captures.assignBody}
            </Text>

            {/* Search only earns its place on a long list (see `showSearch`);
                a rounded field with a leading glyph, the picker grammar Mobbin
                shows across Starling/Swarm/Canva. */}
            {showSearch ? (
              <Row
                style={{
                  gap: theme.spacing.sm,
                  alignItems: 'center',
                  backgroundColor: theme.color.surfaceMuted,
                  borderRadius: theme.radius.md,
                  paddingHorizontal: theme.spacing.md,
                }}
              >
                <Ionicons name="search" size={iconSize.md} color={theme.color.textFaint} />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder={t.captures.assignSearch}
                  placeholderTextColor={theme.color.textFaint}
                  accessibilityLabel={t.captures.assignSearch}
                  autoCorrect={false}
                  style={{
                    flex: 1,
                    fontSize: 16,
                    color: theme.color.text,
                    paddingVertical: theme.spacing.md,
                  }}
                />
              </Row>
            ) : null}

            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              style={{ flexShrink: 1 }}
            >
              {/* Start a group and drop this into it — so a capture with no
                  fitting group is no longer a dead end (it used to only say
                  "make one first"). Mirrors the "Create group" affordance the
                  Wise/Starling pickers lead with. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.captures.assignNew}
                onPress={() => {
                  closeAssign();
                  router.push('/new-group');
                }}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing.md,
                  paddingVertical: theme.spacing.md,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <View
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: theme.color.surfaceMuted,
                    borderWidth: 1,
                    borderColor: theme.color.border,
                    borderStyle: 'dashed',
                  }}
                >
                  <Ionicons name="add" size={iconSize.lg} color={theme.color.brand} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text variant="subheading" numberOfLines={1}>
                    {t.captures.assignNew}
                  </Text>
                  <Text variant="caption" tone="muted" numberOfLines={1}>
                    {t.captures.assignNewBody}
                  </Text>
                </View>
              </Pressable>

              <View style={{ height: 1, backgroundColor: theme.color.border }} />

              {assignableGroups.length === 0 ? (
                <Text variant="caption" tone="muted" style={{ paddingVertical: theme.spacing.lg }}>
                  {t.captures.noGroups}
                </Text>
              ) : visibleGroups.length === 0 ? (
                <Text variant="caption" tone="muted" style={{ paddingVertical: theme.spacing.lg }}>
                  {t.captures.assignNoMatch}
                </Text>
              ) : (
                visibleGroups.map((group) => {
                  const label = groupLabel(group, summary.membersFor(group.id), profile?.id);
                  return (
                    <Pressable
                      key={group.id}
                      accessibilityRole="button"
                      accessibilityLabel={label}
                      onPress={() => {
                        // The Modal stays mounted through its fade-out, so this
                        // can fire a frame after the backdrop cleared `assigning`.
                        if (assigning) assignTo(assigning, group);
                      }}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: theme.spacing.md,
                        paddingVertical: theme.spacing.md,
                        opacity: pressed ? 0.6 : 1,
                      })}
                    >
                      {/* The group's own avatar and colour carry its identity —
                          the flat-row look the dashboard's GroupCard uses. */}
                      <Avatar
                        name={label}
                        emoji={group.cover_emoji ?? undefined}
                        size={44}
                        tint={tintForKey(group.id)}
                      />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text variant="subheading" numberOfLines={1}>
                          {label}
                        </Text>
                        <Text variant="caption" tone="muted" numberOfLines={1}>
                          {plural(locale, summary.memberCountFor(group.id), t.memberCount)}
                        </Text>
                      </View>
                      <Ionicons
                        name={directionalIcon('chevron-forward')}
                        size={iconSize.md}
                        color={theme.color.textFaint}
                      />
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}
