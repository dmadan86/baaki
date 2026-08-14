/**
 * When the trip is, and the two reminders a day that come with it.
 *
 * The reason to ask for dates at all is the reminders. Four people go to Goa;
 * on day one everybody adds everything; by day three nobody has entered
 * anything since the first lunch, and on the flight home somebody tries to
 * reconstruct a week of autorickshaws from memory. A shared ledger is only as
 * good as the habit of adding to it, and the habit needs prompting while the
 * receipts still exist.
 *
 * The times are settable because "breakfast" is not a fixed hour, and a group
 * asked at the wrong one mutes the app rather than moving the setting. The
 * timezone is the trip's rather than each reader's for the same reason: a
 * question about dinner should not arrive at 04:00.
 */

import { useState } from 'react';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Platform, Pressable, View } from 'react-native';

import { Button, Card, Row, Text, Toggle, useTheme } from '@baaki/ui';

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
  Morning = 'morning',
  Evening = 'evening',
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

function timeFrom(value: string): Date {
  const [hours, minutes] = value.split(':').map(Number);
  const date = new Date();
  date.setHours(hours ?? 9, minutes ?? 0, 0, 0);
  return date;
}

function isoTime(value: Date): string {
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:00`;
}

/** "9:00 am" in whatever the reader's phone calls that. */
function showTime(value: string, locale: string): string {
  return timeFrom(value).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

function showDate(iso: string | null, locale: string): string {
  if (!iso) return 'Not set';
  return dateFrom(iso).toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

const deviceZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';

/** A tappable label + value that opens the picker for one field. */
function FieldRow({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={onPress}
      style={{ flex: 1, gap: 2 }}
    >
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="subheading">{value}</Text>
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

  const hasDates = Boolean(group.start_date && group.end_date);

  const apply = (field: Field, event: DateTimePickerEvent, picked?: Date): void => {
    // Android's picker is a modal that reports its own dismissal; iOS's is
    // inline and reports every scroll.
    if (Platform.OS === 'android') setEditing(null);
    if (event.type === 'dismissed' || !picked) return;

    switch (field) {
      case Field.Start: {
        const start = isoDate(picked);
        // An end date before the start is not a trip. Dragging the start past
        // the end moves the end rather than refusing the tap.
        const end = group.end_date && group.end_date < start ? start : group.end_date;
        onChange({ start_date: start, end_date: end ?? start, time_zone: group.time_zone });
        return;
      }
      case Field.End: {
        const end = isoDate(picked);
        const start = group.start_date && group.start_date > end ? end : group.start_date;
        onChange({ end_date: end, start_date: start ?? end });
        return;
      }
      case Field.Morning:
        onChange({ remind_morning_at: isoTime(picked) });
        return;
      default:
        onChange({ remind_evening_at: isoTime(picked) });
    }
  };

  return (
    <Card style={{ gap: theme.spacing.lg }}>
      <View style={{ gap: theme.spacing.xs }}>
        <Row style={{ justifyContent: 'space-between', gap: theme.spacing.sm }}>
          <Text variant="subheading">Trip dates</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showInfo }}
            accessibilityLabel="About trip dates"
            hitSlop={8}
            onPress={() => setShowInfo((open) => !open)}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Ionicons
              name={showInfo ? 'information-circle' : 'information-circle-outline'}
              size={20}
              color={showInfo ? theme.color.brand : theme.color.textFaint}
            />
          </Pressable>
        </Row>
        {showInfo ? (
          <Text variant="caption" tone="muted">
            While the trip is on, everybody gets a nudge to add what they spent — at breakfast about
            yesterday, and at the end of the day about today. Nobody is asked about a day they have
            already added to.
          </Text>
        ) : null}
      </View>

      <Row style={{ gap: theme.spacing.lg }}>
        <FieldRow
          label={t.pickers.starts}
          value={showDate(group.start_date, locale)}
          onPress={() => setEditing(Field.Start)}
        />
        <FieldRow
          label={t.pickers.ends}
          value={showDate(group.end_date, locale)}
          onPress={() => setEditing(Field.End)}
        />
      </Row>

      {hasDates ? (
        <>
          <View style={{ height: 1, backgroundColor: theme.color.border }} />

          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: theme.spacing.lg }}>
              <Text variant="subheading">{t.pickers.dailyReminders}</Text>
              <Text variant="caption" tone="muted">
                {`Asked in ${group.time_zone.replace(/_/g, ' ')} — where the trip is, not where each person is.`}
              </Text>
            </View>
            <Toggle
              value={group.remind_daily}
              onValueChange={(value) => onChange({ remind_daily: value })}
              accessibilityLabel={t.pickers.dailyReminders}
            />
          </Row>

          {group.remind_daily ? (
            <>
              <Row style={{ gap: theme.spacing.lg }}>
                <FieldRow
                  label={t.pickers.breakfast}
                  value={showTime(group.remind_morning_at, locale)}
                  onPress={() => setEditing(Field.Morning)}
                />
                <FieldRow
                  label={t.pickers.endOfDay}
                  value={showTime(group.remind_evening_at, locale)}
                  onPress={() => setEditing(Field.Evening)}
                />
              </Row>

              {group.time_zone !== deviceZone() ? (
                <Button
                  label={`Use my timezone (${deviceZone().split('/').pop()?.replace(/_/g, ' ')})`}
                  size="sm"
                  variant="ghost"
                  onPress={() => onChange({ time_zone: deviceZone() })}
                />
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
          <Ionicons name="information-circle-outline" size={16} color={theme.color.textFaint} />
          <Text variant="micro" tone="faint" style={{ flex: 1 }}>
            A flatshare has no start and no end — leave these empty and nothing is sent.
          </Text>
        </Row>
      )}

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
          value={
            editing === Field.Start
              ? dateFrom(group.start_date)
              : editing === Field.End
                ? dateFrom(group.end_date)
                : timeFrom(
                    editing === Field.Morning ? group.remind_morning_at : group.remind_evening_at,
                  )
          }
          mode={editing === Field.Start || editing === Field.End ? 'date' : 'time'}
          // The end of a trip cannot be before its beginning, so the picker
          // does not offer it.
          minimumDate={editing === Field.End ? dateFrom(group.start_date) : undefined}
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
