/**
 * The "where did this happen" control the expense forms share (A43).
 *
 * Location is optional and opt-in: nothing is read until the person taps "Add
 * location", at which point the permission is asked for just-in-time (the same
 * deferred model push uses). A grant reads one fix, names it on the device, and
 * hands it back; a refusal says so and offers Settings, because on iOS a denied
 * location cannot be re-asked from inside the app. It never blocks saving — an
 * expense with no place is exactly what every expense was before this existed.
 *
 * Shared by the capture screen and the group add-expense screen so the two
 * present and behave identically rather than each carrying its own copy.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Linking, Pressable, View } from 'react-native';

import type { ExpenseLocation } from '@waves/core';
import { Button, Callout, Card, iconSize, Row, Text, useTheme } from '@waves/ui';

import { LocationPickerSheet } from '@/components/LocationPickerSheet';
import { MapPreview } from '@/components/MapPreview';
import { useStrings } from '@/i18n';
import { captureLocation, coordLabel, LocationFailure, locationAvailable } from '@/lib/location';

export function LocationField({
  value,
  onChange,
  busy: busyExternal = false,
}: {
  value: ExpenseLocation | null;
  onChange: (location: ExpenseLocation | null) => void;
  /**
   * An owner is already reading a fix (the voice review reads the current place
   * on its own, up front). Shown as a "getting location" placeholder in place of
   * the buttons, so the field reads as working rather than empty while it lands.
   */
  busy?: boolean;
}): React.JSX.Element | null {
  const theme = useTheme();
  const { t } = useStrings();
  const [working, setWorking] = useState(false);
  // 'denied' offers Settings; 'unavailable' just invites another try. Cleared
  // the moment a fresh attempt starts.
  const [failure, setFailure] = useState<LocationFailure | null>(null);
  // The full-screen map: opened to adjust an existing pin, or to pick a spot
  // by hand when the person is not standing where the money was spent.
  const [pickerOpen, setPickerOpen] = useState(false);

  // Web and a build with no location module have nothing to offer — the whole
  // field is absent rather than a button that can only fail.
  if (!locationAvailable()) return null;

  const add = async (): Promise<void> => {
    setFailure(null);
    setWorking(true);
    try {
      const result = await captureLocation();
      if (result.ok) {
        onChange(result.location);
      } else if (result.why !== LocationFailure.Unsupported) {
        setFailure(result.why);
      }
    } finally {
      setWorking(false);
    }
  };

  // Either this field's own tap or an owner-driven read (the voice review) counts
  // as busy — both put the field in the same "getting location" state.
  const busy = working || busyExternal;
  const label = value ? value.name?.trim() || coordLabel(value) : '';

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="caption" tone="muted">
        {t.location.label}
      </Text>

      {value ? (
        <Card style={{ gap: theme.spacing.sm, padding: theme.spacing.sm }}>
          {/* A little map of the point — tap it to open the picker and adjust. */}
          <MapPreview
            location={value}
            onPress={() => setPickerOpen(true)}
            accessibilityLabel={t.location.adjust}
          />
          <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
            <Ionicons name="location" size={iconSize.md} color={theme.color.brand} />
            <Text variant="subheading" numberOfLines={1} style={{ flex: 1 }}>
              {label}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.location.adjust}
              onPress={() => setPickerOpen(true)}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Ionicons name="create-outline" size={iconSize.md} color={theme.color.brand} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.location.remove}
              onPress={() => onChange(null)}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Ionicons name="close-circle" size={iconSize.md} color={theme.color.textFaint} />
            </Pressable>
          </Row>
        </Card>
      ) : busy ? (
        // A fix is on its way — read the current place rather than showing empty
        // buttons that look like nothing has happened.
        <Row
          style={{ gap: theme.spacing.sm, alignItems: 'center', paddingVertical: theme.spacing.xs }}
        >
          <ActivityIndicator size="small" color={theme.color.brand} />
          <Text tone="muted">{t.location.adding}</Text>
        </Row>
      ) : (
        <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap' }}>
          <Button
            label={t.location.add}
            variant="secondary"
            size="sm"
            onPress={() => void add()}
            icon={<Ionicons name="location-outline" size={iconSize.md} color={theme.color.brand} />}
          />
          {/* The manual path: choose a spot on the map when you are not there. */}
          <Button
            label={t.location.pick}
            variant="secondary"
            size="sm"
            onPress={() => setPickerOpen(true)}
            icon={<Ionicons name="map-outline" size={iconSize.md} color={theme.color.brand} />}
          />
        </Row>
      )}

      <LocationPickerSheet
        visible={pickerOpen}
        initial={value}
        onClose={() => setPickerOpen(false)}
        onConfirm={(picked) => {
          onChange(picked);
          setPickerOpen(false);
        }}
      />

      {failure === LocationFailure.Denied ? (
        <View style={{ gap: theme.spacing.sm }}>
          <Callout tone="info">{t.location.blocked}</Callout>
          <Button
            label={t.location.openSettings}
            variant="ghost"
            size="sm"
            onPress={() => void Linking.openSettings().catch(() => undefined)}
          />
        </View>
      ) : failure === LocationFailure.Unavailable ? (
        <Callout tone="info">{t.location.unavailable}</Callout>
      ) : null}
    </View>
  );
}
