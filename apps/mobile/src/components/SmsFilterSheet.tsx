/**
 * Narrowing the Bank messages list by date, past what the chips can say.
 *
 * The screen itself carries four chips — 7 days, 30, 90, all — because that is
 * the question nine times out of ten and a chip answers it in one tap. This
 * sheet is the other two answers, and it is behind an icon precisely because
 * they are the rarer ones:
 *
 *   * **A month.** How people think about a statement: "September". A stepper
 *     rather than a picker, and it steps only through months that actually hold
 *     messages — a stepper that can land on an empty screen is one people press
 *     twice and then stop trusting.
 *   * **Your own dates.** For the trip that ran from the 14th to the 22nd and
 *     does not respect a calendar. The same inline {@link RangeCalendar} the
 *     Activity feed uses, so "pick two days" is one control in this app rather
 *     than two that drifted apart.
 *
 * A month applies and closes on the tap, because the tap is the whole choice. A
 * custom range waits for **Show these**, because it takes two taps to express
 * and the list behind should not flicker between them.
 */

import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, View } from 'react-native';

import { Button, ChipRow, Divider, iconSize, Row, Sheet, Text, useTheme } from '@waves/ui';

import { RangeCalendar } from '@/components/RangeCalendar';
import { useStrings } from '@/i18n';
import { gregorianFormatter } from '@/lib/calendarGrid';
import { ALL_TIME, monthOf, monthsPresent, stepMonth, type SmsDateFilter } from '@/lib/smsInbox';
import type { StoredSms } from '@/lib/smsMessageTypes';

/** A `YYYY-MM` as a date at local noon, which is what the formatters want. */
const monthDate = (month: string): Date =>
  new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1, 12);

/**
 * A month as words, with the raw `YYYY-MM` as the fallback.
 *
 * `gregorianFormatter` answers null on a runtime with no usable Intl data — a
 * stripped Hermes build, an odd locale tag — and a stepper whose label vanished
 * would leave two chevrons either side of nothing. "2026-09" is a poor label
 * and an excellent fallback.
 */
function monthWords(month: string, locale: string): string {
  return (
    gregorianFormatter(locale, { month: 'long', year: 'numeric' })?.format(monthDate(month)) ??
    month
  );
}

const dayIso = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;

const isoDate = (iso: string): Date =>
  new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), 12);

export function SmsFilterSheet({
  visible,
  rows,
  value,
  onApply,
  onClose,
}: {
  visible: boolean;
  /** Every message this account has — what decides which months exist. */
  rows: readonly StoredSms[];
  value: SmsDateFilter;
  onApply: (filter: SmsDateFilter) => void;
  onClose: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { t, locale } = useStrings();

  const months = useMemo(() => monthsPresent(rows), [rows]);

  // Which month the stepper is sitting on. Opens on the one already chosen,
  // else the newest month that has anything in it.
  const [month, setMonth] = useState<string | null>(
    value.kind === 'month' ? value.month : (months[0] ?? null),
  );

  const [start, setStart] = useState<Date | null>(
    value.kind === 'range' ? isoDate(value.from) : null,
  );
  const [end, setEnd] = useState<Date | null>(value.kind === 'range' ? isoDate(value.to) : null);

  const older = month ? stepMonth(months, month, 'older') : null;
  const newer = month ? stepMonth(months, month, 'newer') : null;

  // The calendar is clamped to the span this account actually has messages in;
  // a day before the first or after the last cannot be chosen.
  const span = useMemo(() => {
    if (rows.length === 0) return null;
    let earliest = rows[0]!.occurredOn;
    let latest = rows[0]!.occurredOn;
    for (const row of rows) {
      if (row.occurredOn < earliest) earliest = row.occurredOn;
      if (row.occurredOn > latest) latest = row.occurredOn;
    }
    return { earliest: isoDate(earliest), latest: isoDate(latest) };
  }, [rows]);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      closeLabel={t.common.close}
      style={{ paddingHorizontal: theme.spacing.xl, gap: theme.spacing.lg }}
    >
      <Text variant="heading">{t.smsInbox.filterTitle}</Text>

      {/* The four windows people actually reach for. They used to be a band of
          chips under the hero, on a screen whose whole problem was bands: four
          of them stacked before the first message. They belong with the other
          date controls, and the screen says which one is on. */}
      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="caption" tone="muted">
          {t.smsInbox.filterRecent}
        </Text>
        <ChipRow<string>
          value={value.kind === 'window' ? String(value.days) : ''}
          onChange={(days) => onApply({ kind: 'window', days: Number(days) as 0 | 7 | 30 | 90 })}
          options={[
            { value: '7', label: t.smsInbox.last7 },
            { value: '30', label: t.smsInbox.last30 },
            { value: '90', label: t.smsInbox.last90 },
            { value: '0', label: t.smsInbox.allTime },
          ]}
        />
      </View>

      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="caption" tone="muted">
          {t.smsInbox.filterByMonth}
        </Text>
        <Row style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          {/* `older` is the *earlier* month, so on an RTL layout these swap
              with the reading direction — `directionalIcon` is not used here
              because the chevrons point along the list's own time axis, which
              mirrors with the script. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.smsInbox.filterOlder}
            accessibilityState={{ disabled: older === null }}
            disabled={older === null}
            hitSlop={8}
            onPress={() => older && setMonth(older)}
            style={{ opacity: older === null ? 0.3 : 1, padding: theme.spacing.xs }}
          >
            <Ionicons name="chevron-back" size={iconSize.md} color={theme.color.text} />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={month ? monthWords(month, locale) : t.smsInbox.allTime}
            disabled={month === null}
            onPress={() => month && onApply({ kind: 'month', month })}
            style={({ pressed }) => ({ flex: 1, alignItems: 'center', opacity: pressed ? 0.6 : 1 })}
          >
            <Text variant="subheading">
              {month ? monthWords(month, locale) : t.smsInbox.allTime}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.smsInbox.filterNewer}
            accessibilityState={{ disabled: newer === null }}
            disabled={newer === null}
            hitSlop={8}
            onPress={() => newer && setMonth(newer)}
            style={{ opacity: newer === null ? 0.3 : 1, padding: theme.spacing.xs }}
          >
            <Ionicons name="chevron-forward" size={iconSize.md} color={theme.color.text} />
          </Pressable>
        </Row>
      </View>

      <Divider />

      <Text variant="caption" tone="muted">
        {t.smsInbox.filterCustom}
      </Text>
      <ScrollView showsVerticalScrollIndicator={false} style={{ flexShrink: 1 }}>
        <RangeCalendar
          earliest={span?.earliest ?? null}
          latest={span?.latest ?? null}
          locale={locale}
          start={start}
          end={end}
          onSelect={(nextStart, nextEnd) => {
            setStart(nextStart);
            setEnd(nextEnd);
          }}
        />
      </ScrollView>

      <Row style={{ gap: theme.spacing.sm }}>
        <Button
          label={t.smsInbox.filterClear}
          variant="ghost"
          style={{ flex: 1 }}
          onPress={() => onApply(ALL_TIME)}
        />
        <Button
          label={t.smsInbox.filterApply}
          style={{ flex: 1 }}
          // Only once both ends are chosen: a half-made range would silently
          // become "that one day", which is not what the person was doing.
          disabled={start === null || end === null}
          onPress={() =>
            start && end && onApply({ kind: 'range', from: dayIso(start), to: dayIso(end) })
          }
        />
      </Row>
    </Sheet>
  );
}

/** The words a chosen filter wears on the screen's own control. */
export function filterLabel(
  filter: SmsDateFilter,
  locale: string,
  t: ReturnType<typeof useStrings>['t'],
): string {
  switch (filter.kind) {
    case 'window':
      return filter.days === 0
        ? t.smsInbox.allTime
        : filter.days === 7
          ? t.smsInbox.last7
          : filter.days === 30
            ? t.smsInbox.last30
            : t.smsInbox.last90;
    case 'month':
      return monthWords(filter.month, locale);
    case 'range': {
      const short = gregorianFormatter(locale, { day: 'numeric', month: 'short' });
      return short
        ? `${short.format(isoDate(filter.from))} – ${short.format(isoDate(filter.to))}`
        : `${filter.from} – ${filter.to}`;
    }
  }
}

export { monthOf };
