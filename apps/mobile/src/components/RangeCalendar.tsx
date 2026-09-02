/**
 * An inline month calendar with range selection — the modern date-range control
 * (Monzo, Spotify, StubHub): one calendar on screen, tap the start day then the
 * end day, the span between them tinted. It replaces the old from/to pair that
 * opened a native picker modal per end (open, pick, dismiss, open, pick, dismiss
 * — four taps before Apply). Here a custom range is two taps on a calendar that
 * never leaves the sheet.
 *
 * Pure React Native, no calendar dependency: the feed is small and the control
 * is simple, so a hand-built month grid avoids adding a native-ish library for
 * one screen. Days outside the feed's own span (`earliest`/`latest`) are
 * disabled, and month paging stops at the months that hold those bounds — you
 * cannot wander into empty time. Every day is anchored at local noon so the grid
 * is DST-proof and agrees with the `DateRange` the sheet commits.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View } from 'react-native';

import { directionalIcon, iconSize, Row, Text, useTheme } from '@waves/ui';

/** A calendar day at local noon — the anchor the whole control works in. */
function dayAt(year: number, month: number, date: number): Date {
  return new Date(year, month, date, 12, 0, 0, 0);
}

function startOfDay(d: Date): Date {
  return dayAt(d.getFullYear(), d.getMonth(), d.getDate());
}

function firstOfMonth(d: Date): Date {
  return dayAt(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, delta: number): Date {
  return dayAt(d.getFullYear(), d.getMonth() + delta, 1);
}

/** Whole days between two day-anchors (b − a), sign preserved. */
function dayDiff(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** The seven weekday initials in the reader's language, Sunday first. */
function weekdayLabels(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
  // 2023-01-01 was a Sunday — walk a known week to get localized initials.
  return Array.from({ length: 7 }, (_, i) => fmt.format(dayAt(2023, 0, 1 + i)));
}

function monthLabel(d: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(d);
  } catch {
    return `${d.getFullYear()}-${d.getMonth() + 1}`;
  }
}

const CELL = 40;

export function RangeCalendar({
  earliest,
  latest,
  locale,
  start,
  end,
  onSelect,
}: {
  earliest: Date;
  latest: Date;
  locale: string;
  start: Date | null;
  end: Date | null;
  /** Emits the new range ends after a tap; `end` is null mid-selection. */
  onSelect: (start: Date | null, end: Date | null) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const lo = startOfDay(earliest);
  const hi = startOfDay(latest);

  // Which month the grid shows — opens on the current start, else the latest
  // event's month (the newest activity, where the reader most likely looks).
  const [view, setView] = useState<Date>(() => firstOfMonth(start ?? latest));

  const canPrev = firstOfMonth(view).getTime() > firstOfMonth(lo).getTime();
  const canNext = firstOfMonth(view).getTime() < firstOfMonth(hi).getTime();

  const inBounds = (d: Date): boolean => d.getTime() >= lo.getTime() && d.getTime() <= hi.getTime();

  // The selection span, ordered, for the tint band.
  const spanLo = start && end ? (start <= end ? start : end) : start;
  const spanHi = start && end ? (start <= end ? end : start) : start;
  const inSpan = (d: Date): boolean =>
    spanLo !== null &&
    spanHi !== null &&
    d.getTime() >= spanLo.getTime() &&
    d.getTime() <= spanHi.getTime();

  const pick = (d: Date): void => {
    // Fresh start when nothing is pending or the range is already whole; else
    // close the range on the second tap. The sheet orders the two ends, so an
    // end-before-start tap is fine.
    if (start === null || end !== null) onSelect(d, null);
    else onSelect(start, d);
  };

  // Build the grid: lead blanks for the first-of-month's weekday, then the days.
  const first = firstOfMonth(view);
  const lead = first.getDay(); // 0 = Sunday
  const daysInMonth = dayDiff(first, addMonths(view, 1));
  const cells: (Date | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) =>
      dayAt(view.getFullYear(), view.getMonth(), i + 1),
    ),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return (
    <View style={{ gap: theme.spacing.sm }}>
      {/* Month header with ‹ › paging, clamped to the feed's months. */}
      <Row style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={monthLabel(addMonths(view, -1), locale)}
          disabled={!canPrev}
          onPress={() => setView((v) => addMonths(v, -1))}
          hitSlop={10}
          style={({ pressed }) => ({ opacity: !canPrev ? 0.3 : pressed ? 0.5 : 1, padding: 4 })}
        >
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.md}
            color={theme.color.text}
          />
        </Pressable>
        <Text variant="subheading" style={{ fontWeight: '700' }}>
          {monthLabel(view, locale)}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={monthLabel(addMonths(view, 1), locale)}
          disabled={!canNext}
          onPress={() => setView((v) => addMonths(v, 1))}
          hitSlop={10}
          style={({ pressed }) => ({ opacity: !canNext ? 0.3 : pressed ? 0.5 : 1, padding: 4 })}
        >
          <Ionicons
            name={directionalIcon('chevron-forward')}
            size={iconSize.md}
            color={theme.color.text}
          />
        </Pressable>
      </Row>

      {/* Weekday initials. */}
      <Row>
        {weekdayLabels(locale).map((w, i) => (
          <View key={i} style={{ width: CELL, alignItems: 'center' }}>
            <Text variant="micro" tone="faint" style={{ fontWeight: '600' }}>
              {w}
            </Text>
          </View>
        ))}
      </Row>

      {/* The day grid. */}
      <View style={{ gap: 2 }}>
        {weeks.map((week, wi) => (
          <Row key={wi}>
            {week.map((d, di) => {
              if (!d) return <View key={di} style={{ width: CELL, height: CELL }} />;
              const disabled = !inBounds(d);
              const isEnd = (spanLo && sameDay(d, spanLo)) || (spanHi && sameDay(d, spanHi));
              const banded = inSpan(d) && !isEnd;
              return (
                <Pressable
                  key={di}
                  accessibilityRole="button"
                  accessibilityLabel={d.toLocaleDateString(locale, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })}
                  accessibilityState={{ disabled, selected: Boolean(isEnd) }}
                  disabled={disabled}
                  onPress={() => pick(d)}
                  style={{
                    width: CELL,
                    height: CELL,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: banded ? theme.color.brandSoft : 'transparent',
                    borderRadius: banded ? 0 : theme.radius.md,
                  }}
                >
                  <View
                    style={{
                      width: CELL - 6,
                      height: CELL - 6,
                      borderRadius: (CELL - 6) / 2,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: isEnd ? theme.color.brand : 'transparent',
                    }}
                  >
                    <Text
                      variant="body"
                      style={{
                        color: isEnd
                          ? theme.color.onBrand
                          : disabled
                            ? theme.color.textFaint
                            : theme.color.text,
                        fontWeight: isEnd ? '700' : '500',
                      }}
                    >
                      {d.getDate()}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </Row>
        ))}
      </View>
    </View>
  );
}
