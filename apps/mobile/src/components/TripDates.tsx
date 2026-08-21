/**
 * When the trip is — its start and end, as one framed range.
 *
 * The span is worth recording on its own: it labels the group with its dates
 * and marks how long the shared ledger was meant to cover. The daily-reminder
 * controls that used to live here were removed, so this card now only asks the
 * two dates; the underlying `remind_*` fields stay on the type for whatever
 * else reads them, but nothing here sets them.
 */

import { useState } from 'react';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Platform, Pressable, View } from 'react-native';

import { Button, Card, directionalIcon, iconSize, Row, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';

/**
 * Only the fields this card reads and writes — not a whole `GroupRow`. A saved
 * group satisfies it structurally, and so does the local state of a group being
 * created, which is what lets the create screen reuse this editor before there
 * is a group to point at.
 */
export interface TripDatesValue {
  start_date: string | null;
  end_date: string | null;
  time_zone: string;
  remind_daily: boolean;
  remind_morning_at: string;
  remind_evening_at: string;
}

enum Field {
  Start = 'start',
  End = 'end',
}

export interface TripDatesPatch {
  start_date?: string | null;
  end_date?: string | null;
  time_zone?: string;
  remind_daily?: boolean;
  remind_morning_at?: string;
  remind_evening_at?: string;
}

/**
 * Parsed as local noon rather than midnight. A date-only string turned into
 * midnight UTC lands on the previous day for anybody west of Greenwich, which
 * is how a trip silently starts a day early.
 */
function dateFrom(iso: string | null): Date {
  if (!iso) return new Date();
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year ?? 2026, (month ?? 1) - 1, day ?? 1, 12);
}

function isoDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function showDate(iso: string | null, locale: string, notSet: string): string {
  if (!iso) return notSet;
  return dateFrom(iso).toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * One end of the range — a tappable label over a big date, filling half the
 * framed sweep. `align` hugs the start date to the outer left and the end date
 * to the outer right, so the arrow between them reads as the span of the trip.
 */
function RangeEnd({
  label,
  value,
  onPress,
  align,
}: {
  label: string;
  value: string;
  onPress: () => void;
  align: 'flex-start' | 'flex-end';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={onPress}
      style={{ flex: 1, gap: 2, alignItems: align }}
    >
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="subheading" style={{ fontWeight: '700' }}>
        {value}
      </Text>
    </Pressable>
  );
}

export function TripDates({
  group,
  locale,
  onChange,
}: {
  group: TripDatesValue;
  locale: string;
  onChange: (patch: TripDatesPatch) => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const [editing, setEditing] = useState<Field | null>(null);
  // The why-does-this-exist paragraph is long, and once you have read it once
  // you do not need it every time you open settings. Folded behind the info
  // icon by default; the dates themselves stay in view.
  const [showInfo, setShowInfo] = useState(false);

  const apply = (field: Field, event: DateTimePickerEvent, picked?: Date): void => {
    // Android's picker is a modal that reports its own dismissal; iOS's is
    // inline and reports every scroll.
    if (Platform.OS === 'android') setEditing(null);
    if (event.type === 'dismissed' || !picked) return;

    if (field === Field.Start) {
      const start = isoDate(picked);
      // An end date before the start is not a trip. Dragging the start past
      // the end moves the end rather than refusing the tap.
      const end = group.end_date && group.end_date < start ? start : group.end_date;
      onChange({ start_date: start, end_date: end ?? start, time_zone: group.time_zone });
      return;
    }
    const end = isoDate(picked);
    const start = group.start_date && group.start_date > end ? end : group.start_date;
    onChange({ end_date: end, start_date: start ?? end });
  };

  return (
    <Card style={{ gap: theme.spacing.lg }}>
      <View style={{ gap: theme.spacing.xs }}>
        <Row style={{ justifyContent: 'space-between', gap: theme.spacing.sm }}>
          <Text variant="subheading">{t.misc.tripDatesTitle}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showInfo }}
            accessibilityLabel={t.misc.aboutTripDates}
            hitSlop={8}
            onPress={() => setShowInfo((open) => !open)}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Ionicons
              name={showInfo ? 'information-circle' : 'information-circle-outline'}
              size={iconSize.lg}
              color={showInfo ? theme.color.brand : theme.color.textFaint}
            />
          </Pressable>
        </Row>
        {showInfo ? (
          <Text variant="caption" tone="muted">
            {t.misc.tripDatesBody}
          </Text>
        ) : null}
      </View>

      {/* The range as one framed Start → End sweep — the dates hug the outer
          edges and a chip-borne arrow spans them, so it reads as a trip's
          length rather than two unrelated fields. */}
      <Row
        style={{
          alignItems: 'center',
          gap: theme.spacing.md,
          backgroundColor: theme.color.surfaceMuted,
          borderRadius: theme.radius.lg,
          paddingVertical: theme.spacing.md,
          paddingHorizontal: theme.spacing.lg,
        }}
      >
        <RangeEnd
          label={t.pickers.starts}
          value={showDate(group.start_date, locale, t.pickers.notSet)}
          onPress={() => setEditing(Field.Start)}
          align="flex-start"
        />
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.surface,
          }}
        >
          <Ionicons
            name={directionalIcon('arrow-forward')}
            size={iconSize.sm}
            color={theme.color.textMuted}
          />
        </View>
        <RangeEnd
          label={t.pickers.ends}
          value={showDate(group.end_date, locale, t.pickers.notSet)}
          onPress={() => setEditing(Field.End)}
          align="flex-end"
        />
      </Row>

      {group.start_date && group.end_date ? (
        <Button
          label={t.pickers.clearDates}
          size="sm"
          variant="ghost"
          onPress={() => onChange({ start_date: null, end_date: null })}
        />
      ) : null}

      {editing ? (
        <DateTimePicker
          value={editing === Field.Start ? dateFrom(group.start_date) : dateFrom(group.end_date)}
          mode="date"
          // The end of a trip cannot be before its beginning, so the picker
          // does not offer it.
          minimumDate={
            editing === Field.End && group.start_date ? dateFrom(group.start_date) : undefined
          }
          onChange={(event, picked) => apply(editing, event, picked)}
        />
      ) : null}

      {Platform.OS === 'ios' && editing ? (
        <Button
          label={t.common.done}
          size="sm"
          variant="secondary"
          onPress={() => setEditing(null)}
        />
      ) : null}
    </Card>
  );
}
