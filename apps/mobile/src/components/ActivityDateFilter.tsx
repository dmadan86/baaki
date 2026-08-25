/**
 * The Activity feed's date-range filter — a bottom sheet holding a From and a
 * To field over one shared date picker.
 *
 * The whole feed is already on the phone (the mirror), so narrowing it is a pure
 * cut on the loaded rows; this component only gathers the range and hands it
 * back. The picker is clamped to the feed's own span (`earliest`/`latest`), so a
 * day before the first event or after the last cannot be chosen — the picker
 * disables everything outside `[earliest, latest]`. (The library only supports
 * that outer clamp; it cannot grey out an isolated empty day inside the span.)
 *
 * A From on its own is a single-day filter — the To defaults to it — and picking
 * a To widens it; the receiver orders the two ends, so an end-first pick is
 * still valid. The draft lives here and is only committed on Apply, so the feed
 * behind the sheet does not flicker as the two ends are chosen.
 */

import { useState } from 'react';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Platform, Pressable, View } from 'react-native';

import { Button, iconSize, Row, Text, useTheme } from '@waves/ui';

import { SheetOverlay } from '@/components/expense/SheetOverlay';
import { useStrings } from '@/i18n';

/** A committed filter range — both ends are calendar-day anchors (local noon). */
export interface DateRange {
  start: Date;
  end: Date;
}

enum Field {
  Start = 'start',
  End = 'end',
}

/**
 * One end of the range — its own bordered box, a small label over the date with
 * a calendar glyph, lighting up in the brand tint once set. The two sit side by
 * side like the from/to of a range picker, matching `TripDates`.
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
  const [editing, setEditing] = useState<Field | null>(null);

  const showDate = (value: Date | null): string =>
    value
      ? value.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })
      : t.pickers.notSet;

  const apply = (field: Field, event: DateTimePickerEvent, picked?: Date): void => {
    // Android's picker is a modal that reports its own dismissal; iOS's is
    // inline and reports every scroll.
    if (Platform.OS === 'android') setEditing(null);
    if (event.type === 'dismissed' || !picked) return;
    if (field === Field.Start) {
      setStart(picked);
      // A To before the new From is not a range — carry the To along rather than
      // refuse the pick.
      setEnd((prev) => (prev && prev < picked ? picked : prev));
      return;
    }
    setEnd(picked);
    setStart((prev) => (prev && prev > picked ? picked : prev));
  };

  return (
    <SheetOverlay title={t.activityFilter.open} onClose={onClose}>
      <View style={{ gap: theme.spacing.lg }}>
        <Row style={{ alignItems: 'stretch', gap: theme.spacing.sm }}>
          <RangeEnd
            label={t.activityFilter.from}
            value={showDate(start)}
            set={Boolean(start)}
            onPress={() => setEditing(Field.Start)}
          />
          <RangeEnd
            label={t.activityFilter.to}
            value={showDate(end ?? start)}
            set={Boolean(end ?? start)}
            onPress={() => setEditing(Field.End)}
          />
        </Row>

        {editing ? (
          <DateTimePicker
            value={(editing === Field.Start ? start : (end ?? start)) ?? earliest}
            mode="date"
            // The selectable span is the feed's own — dates outside it are
            // disabled. The To can never start before the chosen From.
            minimumDate={editing === Field.End && start ? start : earliest}
            maximumDate={latest}
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
                onApply({ start, end: end ?? start });
                onClose();
              }}
            />
          </View>
        </Row>
      </View>
    </SheetOverlay>
  );
}
