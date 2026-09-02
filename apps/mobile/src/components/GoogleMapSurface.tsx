/**
 * The native Google Maps surface for the location picker.
 *
 * Isolated in its own file for the same reason `VoiceCapture` is: it imports a
 * native module (`react-native-maps`) whose JS throws on any binary built before
 * that module existed. `LocationPickerSheet` reaches it through a guarded
 * `require` (see `nativeMaps`) and falls back to the raster-tile map when it is
 * not there — so an OTA update that carries this file to an older build degrades
 * to tiles instead of crashing at launch.
 *
 * It draws only the map itself: a full-bleed Google `MapView` with a fixed
 * centre pin, the point that gets saved. The map pans and pinch-zooms natively;
 * the parent reads the resting centre from `onCenterChange` and drives
 * programmatic moves (reseed, "use my location") through the `mapRef`.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { View } from 'react-native';
import MapView, { PROVIDER_GOOGLE, type Region } from 'react-native-maps';

import { iconSize, useTheme } from '@waves/ui';

import type { LatLng } from '@/lib/mapTiles';

/**
 * A region for a centre point. The deltas set the zoom: a tight span for a known
 * point, a wide one for the "no starting point" world view. Longitude delta is
 * derived from latitude by the frame's aspect so the map is not stretched.
 */
export function regionForCenter(center: LatLng, span: 'point' | 'world', aspect: number): Region {
  const latitudeDelta = span === 'point' ? 0.01 : 90;
  return {
    latitude: center.lat,
    longitude: center.lng,
    latitudeDelta,
    longitudeDelta: latitudeDelta * (aspect > 0 ? aspect : 1),
  };
}

export type GoogleMapHandle = Pick<MapView, 'animateToRegion'>;

export function GoogleMapSurface({
  mapRef,
  initialRegion,
  onCenterChange,
}: {
  mapRef: React.RefObject<MapView | null>;
  initialRegion: Region;
  onCenterChange: (center: LatLng) => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={{ flex: 1 }}
        initialRegion={initialRegion}
        onRegionChangeComplete={(region) =>
          onCenterChange({ lat: region.latitude, lng: region.longitude })
        }
        showsUserLocation
        showsMyLocationButton={false}
        toolbarEnabled={false}
      />
      {/* Fixed centre pin — the point that gets saved, lifted so its tip sits on
          the exact centre of the map. */}
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
    </View>
  );
}
