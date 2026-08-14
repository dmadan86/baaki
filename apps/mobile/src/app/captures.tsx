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

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

import {
  Button,
  Card,
  EmptyState,
  IconButton,
  MoneyText,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { CategoryBadge } from '@/components/Category';
import { capturePhotoUrl } from '@/data/api';
import { useCaptures, useDeleteCapture, useGroups, useHomeSummary } from '@/data/hooks';
import { groupLabel, type CaptureRow, type GroupRow } from '@/data/types';
import { useStrings } from '@/i18n';
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

/** A short-lived signed URL for a capture's receipt, re-resolved when it changes. */
function CaptureThumb({ path, size }: { path: string; size: number }) {
  const theme = useTheme();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void capturePhotoUrl(path).then((resolved) => {
      if (active) setUrl(resolved);
    });
    return () => {
      active = false;
    };
  }, [path]);

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

export default function CapturesScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const pull = usePullRefresh();
  const { profile } = useAuth();

  const captures = useCaptures();
  const deleteCapture = useDeleteCapture();
  const groups = useGroups();
  const summary = useHomeSummary(profile?.id ?? null);

  // Which capture is being assigned, if any — drives the group-picker sheet.
  const [assigning, setAssigning] = useState<CaptureRow | null>(null);

  const rows = captures.data ?? [];

  // Hand the capture's own values to the add-expense form as prefill, and carry
  // its id so that saving there can close the capture (useAssignCapture). The
  // amount travels as the same minor-unit string the row stores.
  const assignTo = (capture: CaptureRow, group: GroupRow): void => {
    setAssigning(null);
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
      <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={22} color={theme.color.text} />
        </IconButton>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="heading">{t.captures.title}</Text>
        </View>
        <IconButton label={t.captures.captureCta} onPress={() => router.push('/capture')}>
          <Ionicons name="add" size={24} color={theme.color.brand} />
        </IconButton>
      </Row>

      {rows.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: theme.spacing.xl }}>
          <EmptyState
            title={t.captures.emptyTitle}
            body={t.captures.emptyBody}
            action={
              <Button label={t.captures.captureCta} onPress={() => router.push('/capture')} />
            }
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: clearance,
            gap: theme.spacing.md,
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
          {rows.map((capture) => (
            <Card key={capture.id} style={{ gap: theme.spacing.md }}>
              <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
                {capture.photo_path ? (
                  <CaptureThumb path={capture.photo_path} size={46} />
                ) : (
                  <CategoryBadge category={capture.category} size={46} />
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <MoneyText
                    amount={BigInt(capture.amount)}
                    currency={capture.currency}
                    locale={locale}
                    variant="subheading"
                  />
                  {capture.description ? (
                    <Text variant="caption" tone="muted" numberOfLines={1}>
                      {capture.description}
                    </Text>
                  ) : null}
                  <Text variant="micro" tone="faint">
                    {shortDate(capture.expense_date, locale)}
                    {capture.pending ? ` · ${t.captures.notSynced}` : ''}
                  </Text>
                </View>
              </Row>

              <Row style={{ gap: theme.spacing.md }}>
                <Button
                  label={t.captures.assign}
                  size="sm"
                  onPress={() => setAssigning(capture)}
                  style={{ flex: 1 }}
                />
                <IconButton
                  label={t.captures.delete}
                  onPress={() => void deleteCapture.mutateAsync(capture.id)}
                >
                  <Ionicons name="trash-outline" size={20} color={theme.color.textMuted} />
                </IconButton>
              </Row>
            </Card>
          ))}
        </ScrollView>
      )}

      {/* The group picker, as a sheet over the list rather than a screen away —
          assigning is one tap and one choice, and a whole route for it would be
          a scroll and a back button around a short list. */}
      {assigning ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.common.close}
          onPress={() => setAssigning(null)}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(10, 10, 26, 0.55)',
            justifyContent: 'flex-end',
          }}
        >
          <Pressable
            // Swallow taps on the sheet itself; only the backdrop dismisses.
            onPress={() => {}}
            style={{
              backgroundColor: theme.color.surface,
              borderTopLeftRadius: theme.radius.lg,
              borderTopRightRadius: theme.radius.lg,
              padding: theme.spacing.xl,
              gap: theme.spacing.md,
              maxHeight: '70%',
            }}
          >
            <Text variant="heading">{t.captures.assignTitle}</Text>
            <Text variant="caption" tone="muted">
              {t.captures.assignBody}
            </Text>

            {(groups.data ?? []).length === 0 ? (
              <Text variant="caption" tone="muted" style={{ paddingVertical: theme.spacing.md }}>
                {t.captures.noGroups}
              </Text>
            ) : (
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                <View style={{ gap: theme.spacing.xs }}>
                  {(groups.data ?? []).map((group) => (
                    <Pressable
                      key={group.id}
                      accessibilityRole="button"
                      accessibilityLabel={groupLabel(
                        group,
                        summary.membersFor(group.id),
                        profile?.id,
                      )}
                      onPress={() => assignTo(assigning, group)}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: theme.spacing.md,
                        paddingVertical: theme.spacing.md,
                        opacity: pressed ? 0.6 : 1,
                      })}
                    >
                      <Text variant="subheading">{group.cover_emoji ?? '👥'}</Text>
                      <Text variant="body" numberOfLines={1} style={{ flex: 1 }}>
                        {groupLabel(group, summary.membersFor(group.id), profile?.id)}
                      </Text>
                      <Ionicons name="chevron-forward" size={18} color={theme.color.textFaint} />
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      ) : null}
    </Screen>
  );
}
