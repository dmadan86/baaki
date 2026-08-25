/**
 * Choose or nudge an expense's location on a map (A43 follow-up).
 *
 * A full-screen map the person taps to move the pin, zooms with +/-, or snaps
 * to their current position. It is built from the same keyless raster tiles as
 * {@link MapPreview} — no native map, no API key — so "pick a point on a map"
 * ships without the fragile native dependency `react-native-maps` would add on
 * this Expo pin. On confirm the chosen coordinate is reverse-geocoded to a name
 * (best-effort) and handed back as a plain {lat,lng,name}.
 *
 * Tapping recentres the map on the tapped point, so the pin — fixed at the
 * centre — ends up exactly where the finger landed. "Use my current location"
 * is the only path here that asks for permission, and only when tapped.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { ActivityIndicator, type LayoutChangeEvent, Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ExpenseLocation } from '@waves/core';
import { Button, iconSize, Row, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import {
  captureLocation,
  captureLocationIfGranted,
  coordLabel,
  reverseGeocode,
} from '@/lib/location';
import {
  clampZoom,
  DEFAULT_TILE_URL,
  DEFAULT_ZOOM,
  type LatLng,
  offsetLatLng,
  TILE_ATTRIBUTION,
  TILE_HEADERS,
  TILE_SIZE,
  tileGrid,
  tileUrl,
} from '@/lib/mapTiles';

const TILE_URL = process.env.EXPO_PUBLIC_MAP_TILE_URL || DEFAULT_TILE_URL;
// Where the map opens when there is no starting point and no granted fix — a
// gentle world view the person zooms into or overrides with "use my location".
const WORLD: LatLng = { lat: 20, lng: 0 };
const WORLD_ZOOM = 2;

export function LocationPickerSheet({
  visible,
  initial,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  initial: ExpenseLocation | null;
  onClose: () => void;
  onConfirm: (location: ExpenseLocation) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  const insets = useSafeAreaInsets();

  const [center, setCenter] = useState<LatLng>(initial ?? WORLD);
  const [zoom, setZoom] = useState(initial ? DEFAULT_ZOOM : WORLD_ZOOM);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);

  // Re-seed the moment the sheet opens: an edit reopens on its saved point; a
  // fresh pick opens on the world view to tap or zoom into. Done during render
  // (the "adjust state when the input changes" pattern the expense form uses)
  // rather than in an effect, so it never fires a cascading extra render.
  const [seededOpen, setSeededOpen] = useState(false);
  if (visible && !seededOpen) {
    setSeededOpen(true);
    setCenter(initial ?? WORLD);
    setZoom(initial ? DEFAULT_ZOOM : WORLD_ZOOM);
  } else if (!visible && seededOpen) {
    setSeededOpen(false);
  }

  // When opening a fresh pick (no starting point), upgrade the world view to the
  // person's position if — and only if — they already granted location, never
  // prompting. The setState lives in the async callback, not the effect body.
  useEffect(() => {
    if (!visible || initial) return;
    let active = true;
    void captureLocationIfGranted().then((loc) => {
      if (active && loc) {
        setCenter({ lat: loc.lat, lng: loc.lng });
        setZoom(DEFAULT_ZOOM);
      }
    });
    return () => {
      active = false;
    };
  }, [visible, initial]);

  const onLayout = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ w: width, h: height });
  };

  // A tap recentres on the tapped point: the fixed centre pin lands where the
  // finger did. The projection turns the pixel offset into a new {lat,lng}.
  const onTapMap = (locationX: number, locationY: number): void => {
    if (size.w <= 0 || size.h <= 0) return;
    setCenter(offsetLatLng(center, zoom, locationX - size.w / 2, locationY - size.h / 2));
  };

  const snapToCurrentLocation = async (): Promise<void> => {
    setLocating(true);
    try {
      const result = await captureLocation();
      if (result.ok) {
        setCenter({ lat: result.location.lat, lng: result.location.lng });
        setZoom(DEFAULT_ZOOM);
      }
    } finally {
      setLocating(false);
    }
  };

  const confirm = async (): Promise<void> => {
    setSaving(true);
    try {
      // Name the chosen point; the coordinate stands on its own if it has none.
      const name = await reverseGeocode(center.lat, center.lng);
      onConfirm({ lat: center.lat, lng: center.lng, name });
    } finally {
      setSaving(false);
    }
  };

  const tiles = size.w > 0 && size.h > 0 ? tileGrid(center, zoom, size.w, size.h) : [];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      transparent={false}
      statusBarTranslucent
    >
      <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
        {/* Header: close + title + coordinate readout. */}
        <Row
          style={{
            paddingTop: insets.top + theme.spacing.sm,
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: theme.spacing.sm,
            gap: theme.spacing.md,
            alignItems: 'center',
            backgroundColor: theme.color.surface,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.common.close}
            onPress={onClose}
            hitSlop={10}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="subheading" numberOfLines={1}>
              {t.location.pickerTitle}
            </Text>
            <Text variant="micro" tone="muted" numberOfLines={1}>
              {coordLabel({ lat: center.lat, lng: center.lng })}
            </Text>
          </View>
        </Row>

        {/* The map. A Pressable captures the tap that moves the pin. */}
        <View style={{ flex: 1 }} onLayout={onLayout}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.location.pickerHint}
            onPress={(event) => onTapMap(event.nativeEvent.locationX, event.nativeEvent.locationY)}
            style={{ flex: 1, backgroundColor: theme.color.bg }}
          >
            {tiles.map((tile) => (
              <Image
                key={`${tile.x}-${tile.y}-${tile.left}`}
                source={{ uri: tileUrl(TILE_URL, tile.x, tile.y, zoom), headers: TILE_HEADERS }}
                style={{
                  position: 'absolute',
                  left: tile.left,
                  top: tile.top,
                  width: TILE_SIZE,
                  height: TILE_SIZE,
                }}
                contentFit="cover"
                transition={120}
                cachePolicy="memory-disk"
              />
            ))}
          </Pressable>

          {/* Fixed centre pin — the point that gets saved. */}
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons
              name="location"
              size={iconSize.xxl}
              color={theme.color.brand}
              style={{ marginTop: -iconSize.xxl / 2 }}
            />
          </View>

          {/* Zoom controls, stacked at the trailing edge. */}
          <View
            style={{
              position: 'absolute',
              right: theme.spacing.lg,
              top: theme.spacing.lg,
              gap: theme.spacing.sm,
            }}
          >
            {(
              [
                ['add', () => setZoom((z) => clampZoom(z + 1)), t.location.zoomIn],
                ['remove', () => setZoom((z) => clampZoom(z - 1)), t.location.zoomOut],
              ] as const
            ).map(([icon, onPress, label]) => (
              <Pressable
                key={icon}
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={onPress}
                style={({ pressed }) => ({
                  width: 44,
                  height: 44,
                  borderRadius: theme.radius.md,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.color.surface,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Ionicons name={icon} size={iconSize.md} color={theme.color.text} />
              </Pressable>
            ))}
          </View>

          {/* Attribution — required by the tile licence (OSM data, CARTO tiles). */}
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              right: 0,
              bottom: 0,
              paddingHorizontal: 4,
              paddingVertical: 2,
              backgroundColor: 'rgba(255, 255, 255, 0.7)',
              borderTopLeftRadius: theme.radius.sm,
            }}
          >
            <Text variant="micro" style={{ color: '#333', fontSize: 9 }}>
              {TILE_ATTRIBUTION}
            </Text>
          </View>
        </View>

        {/* Footer: the hint, "use my location", and the confirm. */}
        <View
          style={{
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.md,
            paddingBottom: insets.bottom + theme.spacing.md,
            gap: theme.spacing.sm,
            borderTopWidth: 1,
            borderTopColor: theme.color.border,
            backgroundColor: theme.color.surface,
          }}
        >
          <Text variant="micro" tone="muted" align="center">
            {t.location.pickerHint}
          </Text>
          <Row style={{ gap: theme.spacing.md }}>
            <View style={{ flex: 1 }}>
              <Button
                label={t.location.useCurrentLocation}
                variant="secondary"
                disabled={locating || saving}
                onPress={() => void snapToCurrentLocation()}
                icon={
                  locating ? (
                    <ActivityIndicator color={theme.color.brand} />
                  ) : (
                    <Ionicons name="locate" size={iconSize.md} color={theme.color.brand} />
                  )
                }
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label={t.location.usePlace}
                disabled={saving || locating}
                onPress={() => void confirm()}
              />
            </View>
          </Row>
        </View>
      </View>
    </Modal>
  );
}
