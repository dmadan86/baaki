/**
 * A little map of where an expense happened (A43 follow-up).
 *
 * Drawn from raster tiles rather than a native map view, so no API key and no
 * native module ever enter the build — the projection math lives in
 * `@/lib/mapTiles` and this only paints its output. A fixed pin marks the point
 * at the centre; the tiles fill in around it. If the tile server is unreachable
 * the images simply do not appear and the neutral map-coloured background shows
 * through, so a blocked network degrades to an empty frame, never a crash.
 *
 * The tile source is `EXPO_PUBLIC_MAP_TILE_URL` when set, else CARTO's keyless
 * basemap (attributed below) — not OSM's public server, which refuses app
 * traffic. A production build under real load should point that at a
 * self-hosted or keyed provider.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { type LayoutChangeEvent, Pressable, View } from 'react-native';

import type { ExpenseLocation } from '@waves/core';
import { iconSize, Text, useTheme } from '@waves/ui';

import {
  DEFAULT_TILE_URL,
  DEFAULT_ZOOM,
  googleStaticMapUrl,
  TILE_ATTRIBUTION,
  TILE_HEADERS,
  TILE_SIZE,
  tileGrid,
  tileUrl,
} from '@/lib/mapTiles';

const TILE_URL = process.env.EXPO_PUBLIC_MAP_TILE_URL || DEFAULT_TILE_URL;

export function MapPreview({
  location,
  zoom = DEFAULT_ZOOM,
  height = 150,
  onPress,
  accessibilityLabel,
}: {
  location: ExpenseLocation;
  zoom?: number;
  height?: number;
  /** Makes the whole preview a button (e.g. open the picker, or the maps app). */
  onPress?: () => void;
  accessibilityLabel?: string;
}): React.JSX.Element {
  const theme = useTheme();
  // Height is fixed; width is whatever the parent gives us, known only after the
  // first layout pass — until then there is nothing to tile.
  const [width, setWidth] = useState(0);
  const onLayout = (event: LayoutChangeEvent): void => {
    setWidth(event.nativeEvent.layout.width);
  };

  // Google Static Maps when a key is configured, else the CARTO tile grid. One
  // composite image vs a mosaic of {z}/{x}/{y} tiles — see `googleStaticMapUrl`.
  const googleUrl = width > 0 ? googleStaticMapUrl(location, zoom, width, height) : null;
  const tiles = width > 0 && !googleUrl ? tileGrid(location, zoom, width, height) : [];

  const body = (
    <View
      onLayout={onLayout}
      style={{
        height,
        borderRadius: theme.radius.md,
        overflow: 'hidden',
        backgroundColor: theme.color.bg,
      }}
    >
      {googleUrl ? (
        <Image
          source={{ uri: googleUrl }}
          style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}
          contentFit="cover"
          transition={120}
          cachePolicy="memory-disk"
        />
      ) : null}
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
          // A tile is a static image; hold it so panning/zooming does not refetch.
          cachePolicy="memory-disk"
        />
      ))}

      {/* The pin sits at the geometric centre, its tip on the point. */}
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
          size={iconSize.xl}
          color={theme.color.brand}
          // Lift it so the point of the pin, not its middle, marks the spot.
          style={{ marginTop: -iconSize.xl / 2 }}
        />
      </View>

      {/* Attribution — required by the tile licence (OSM data, CARTO tiles).
          Not translated: it is a fixed credit, like a copyright line. Hidden for
          the Google image, which carries Google's own credit baked in. */}
      {googleUrl ? null : (
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
      )}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1 })}
    >
      {body}
    </Pressable>
  );
}
