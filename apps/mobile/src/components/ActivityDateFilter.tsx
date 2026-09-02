/**
 * The Activity feed's date-range filter — quick presets over one inline range
 * calendar.
 *
 * The whole feed is already on the phone (the mirror), so narrowing it is a pure
 * cut on the loaded rows; this component only gathers the range and hands it
 * back. The old design paired a From and a To field that each opened a native
 * date-picker modal — open, pick, dismiss, open, pick, dismiss, Apply — four
 * taps before a single-day filter was even set. This is the pattern the industry
 * settled on instead (Monzo, Spotify, StubHub): a row of one-tap presets for the
 * common ranges, and a single always-visible {@link RangeCalendar} for a custom
 * one (tap the start day, tap the end day). A preset applies and closes on the
 * one tap; a custom range is committed on Apply so the feed behind the sheet does
 * not flicker as the two ends are chosen.
 *
 * Everything is clamped to the feed's own span (`earliest`/`latest`) — a day
 * before the first event or after the last cannot be chosen.
 */

import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Button, Row, Text, useTheme } from '@waves/ui';

import { SheetOverlay } from '@/components/expense/SheetOverlay';
import { RangeCalendar } from '@/components/RangeCalendar';
import { useStrings } from '@/i18n';

/** A committed filter range — both ends are calendar-day anchors (local noon). */
export interface DateRange {
  start: Date;
  end: Date;
}

/** A calendar day at local noon — the anchor the whole control works in. */
function dayNoon(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12, 0, 0, 0);
}

export function ActivityDateFilter({
  earliest,
  latest,
  locale,
  initial,
  onApply,
  onClear,
  onClose,
}: {
  /** The feed's own start and end — the picker is clamped to this span. */
  earliest: Date;
  latest: Date;
  locale: string;
  /** The range already in force, so reopening the sheet shows it. */
  initial: DateRange | null;
  onApply: (range: DateRange) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const [start, setStart] = useState<Date | null>(initial?.start ?? null);
  const [end, setEnd] = useState<Date | null>(initial?.end ?? null);

  const lo = dayNoon(earliest);
  const hi = dayNoon(latest);
  const clamp = (d: Date): Date => {
    const day = dayNoon(d);
    if (day.getTime() < lo.getTime()) return lo;
    if (day.getTime() > hi.getTime()) return hi;
    return day;
  };

  // The presets, relative to today but clamped into the feed's span, so a feed
  // that ends before today still yields a sensible (collapsed) range.
  const now = new Date();
  const presets: { label: string; start: Date; end: Date }[] = [
    { label: t.activityFilter.today, start: clamp(now), end: clamp(now) },
    { label: t.activityFilter.last7, start: clamp(addDays(now, -6)), end: clamp(now) },
    { label: t.activityFilter.last30, start: clamp(addDays(now, -29)), end: clamp(now) },
    {
      label: t.activityFilter.thisMonth,
      start: clamp(new Date(now.getFullYear(), now.getMonth(), 1, 12)),
      end: clamp(now),
    },
  ];

  const showDate = (value: Date | null): string =>
    value
      ? value.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })
      : t.pickers.notSet;

  // A preset is a one-tap answer: commit it and close, no Apply needed.
  const applyPreset = (p: { start: Date; end: Date }): void => {
    onApply({ start: p.start, end: p.end });
    onClose();
  };

  const activePreset = (p: { start: Date; end: Date }): boolean =>
    start !== null &&
    end !== null &&
    start.getTime() === p.start.getTime() &&
    end.getTime() === p.end.getTime();

  return (
    <SheetOverlay title={t.activityFilter.open} onClose={onClose}>
      <View style={{ gap: theme.spacing.lg }}>
        {/* One-tap presets — the common ranges, applied immediately. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: theme.spacing.sm }}
        >
          {presets.map((p) => {
            const active = activePreset(p);
            return (
              <Pressable
                key={p.label}
                accessibilityRole="button"
                accessibilityLabel={p.label}
                accessibilityState={{ selected: active }}
                onPress={() => applyPreset(p)}
                style={({ pressed }) => ({
                  paddingVertical: theme.spacing.sm,
                  paddingHorizontal: theme.spacing.md,
                  borderRadius: theme.radius.pill,
                  borderWidth: 1,
                  borderColor: active ? theme.color.brand : theme.color.border,
                  backgroundColor: active ? theme.color.brandSoft : theme.color.surface,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text
                  variant="caption"
                  style={{
                    color: active ? theme.color.brand : theme.color.text,
                    fontWeight: '600',
                  }}
                >
                  {p.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* The selected range, read-only — it echoes the calendar taps below. */}
        <Row style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Text variant="caption" tone="muted">
            {t.activityFilter.from} · {showDate(start)}
          </Text>
          <Text variant="caption" tone="muted">
            {t.activityFilter.to} · {showDate(end ?? start)}
          </Text>
        </Row>

        {/* One inline calendar: tap the start day, then the end day. */}
        <RangeCalendar
          earliest={earliest}
          latest={latest}
          locale={locale}
          start={start}
          end={end}
          onSelect={(s, e) => {
            setStart(s);
            setEnd(e);
          }}
        />

        <Row style={{ gap: theme.spacing.sm }}>
          {initial || start ? (
            <View style={{ flex: 1 }}>
              <Button
                label={t.activityFilter.clear}
                variant="secondary"
                fullWidth
                onPress={() => {
                  onClear();
                  onClose();
                }}
              />
            </View>
          ) : null}
          <View style={{ flex: 1 }}>
            <Button
              label={t.activityFilter.apply}
              disabled={!start}
              fullWidth
              onPress={() => {
                if (!start) return;
                // The sheet orders the two ends, so an end-first pick is valid.
                const a = start;
                const b = end ?? start;
                onApply(a <= b ? { start: a, end: b } : { start: b, end: a });
                onClose();
              }}
            />
          </View>
        </Row>
      </View>
    </SheetOverlay>
  );
}
