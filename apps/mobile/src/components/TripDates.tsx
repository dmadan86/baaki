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

import { Button, Card, iconSize, Row, Text, useTheme } from '@waves/ui';

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
 * One end of the range — its own bordered field, a small label over the date
 * with a calendar glyph. `set` lights the field in the brand tint so a chosen
 * end reads as filled and an untouched one reads as waiting, and the two boxes
 * sit side by side like the from/to of a date-range picker.
 */
function RangeEnd({
  label,
  value,
  set,
  onPress,
}: {
  label: string;
  value: string;
  set: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        gap: 4,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.md,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: set ? theme.color.brand : theme.color.border,
        backgroundColor: set ? theme.color.brandSoft : theme.color.surface,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
        <Ionicons
          name="calendar-outline"
          size={iconSize.sm}
          color={set ? theme.color.brand : theme.color.textMuted}
        />
        <Text variant="subheading" style={{ fontWeight: '700' }}>
          {value}
        </Text>
      </Row>
    </Pressable>
  );
}

export function TripDates({
  group,
  locale,
  onChange,
  embedded = false,
}: {
  group: TripDatesValue;
  locale: string;
  onChange: (patch: TripDatesPatch) => void;
  /**
   * Drop the outer card and the title/info header, leaving just the two date
   * fields, the clear link and the picker — for when this editor is unfolded
   * inside a row of a bigger card that already carries the "Dates" label.
   */
  embedded?: boolean;
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

  const body = (
    <>
      {embedded ? null : (
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
      )}

      {/* Start and end as two side-by-side fields — each its own bordered box
          that lights up once picked, the way a from/to date-range picker reads,
          rather than two labels sharing one strip. */}
      <Row style={{ alignItems: 'stretch', gap: theme.spacing.sm }}>
        <RangeEnd
          label={t.pickers.starts}
          value={showDate(group.start_date, locale, t.pickers.notSet)}
          set={Boolean(group.start_date)}
          onPress={() => setEditing(Field.Start)}
        />
        <RangeEnd
          label={t.pickers.ends}
          value={showDate(group.end_date, locale, t.pickers.notSet)}
          set={Boolean(group.end_date)}
          onPress={() => setEditing(Field.End)}
        />
      </Row>

      {/* A quiet way out, not a competing action: a small muted link tucked
          under the range rather than a full-width button. */}
      {group.start_date && group.end_date ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.pickers.clearDates}
          onPress={() => onChange({ start_date: null, end_date: null })}
          hitSlop={8}
          style={({ pressed }) => ({ alignSelf: 'center', opacity: pressed ? 0.6 : 1 })}
        >
          <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
            <Ionicons
              name="close-circle-outline"
              size={iconSize.sm}
              color={theme.color.textMuted}
            />
            <Text variant="caption" tone="muted">
              {t.pickers.clearDates}
            </Text>
          </Row>
        </Pressable>
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
    </>
  );

  if (embedded) return <View style={{ gap: theme.spacing.lg }}>{body}</View>;
  return <Card style={{ gap: theme.spacing.lg }}>{body}</Card>;
}
