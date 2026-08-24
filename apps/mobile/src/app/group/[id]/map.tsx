/**
 * The trip on a map: every expense that carries a location, dropped as a pin.
 *
 * A read of the ledger the phone already mirrors (ADR-005) — no fetch, works
 * offline, and it plots only what the reader is already allowed to see (RLS
 * dropped the rest before it ever reached the device). It never asks for the
 * phone's own location; these are expense pins, not "where am I".
 *
 * The map is a native module (`react-native-maps`), loaded lazily behind a
 * non-throwing require exactly like `expo-location` (the native-module rule): a
 * build that did not link it — or the web visual-check surface — degrades to a
 * tappable list of places instead of taking the screen down at launch. Either
 * way a place opens in the phone's own maps app, so the feature is useful even
 * with no embedded map.
 */

import { useMemo } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { Linking, Platform, Pressable, ScrollView, View } from 'react-native';

import type { ExpenseLocation } from '@waves/core';
import {
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import { useGroup } from '@/data/hooks';
import { coordLabel, mapsUrl } from '@/lib/location';
import { InsightsSkeleton } from '@/components/Skeletons';
import { useStrings } from '@/i18n';

interface Place {
  readonly id: string;
  readonly description: string;
  readonly location: ExpenseLocation;
  readonly amountMinor: bigint;
  readonly currency: string;
}

interface MapModule {
  readonly default: React.ComponentType<Record<string, unknown>>;
  readonly Marker: React.ComponentType<Record<string, unknown>>;
}

/**
 * `react-native-maps`, or null when it is not linked into this binary (web, or
 * a build without the module). A property-free try/require: a missing module
 * throws on resolution and is caught, never reaching launch.
 */
function loadMaps(): MapModule | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-maps') as Partial<MapModule>;
    if (!mod?.default || !mod?.Marker) return null;
    return mod as MapModule;
  } catch {
    return null;
  }
}

/** A region that fits every pin, with a little padding so none sits on the edge. */
function regionFor(places: readonly Place[]) {
  const lats = places.map((p) => p.location.lat);
  const lngs = places.map((p) => p.location.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    // A single pin has a zero span; give it a street-level default instead.
    latitudeDelta: Math.max((maxLat - minLat) * 1.4, 0.02),
    longitudeDelta: Math.max((maxLng - minLng) * 1.4, 0.02),
  };
}

export default function MapScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';

  const { group, expenses } = useGroup(groupId);

  const places: Place[] = useMemo(
    () =>
      expenses.rows
        .filter((expense) => expense.currentVersion && !expense.deleted_at)
        .map((expense) => {
          const version = expense.currentVersion!;
          if (!version.location) return null;
          return {
            id: expense.id,
            description: version.description,
            location: version.location,
            amountMinor: BigInt(version.amount),
            currency: version.currency,
          };
        })
        .filter((place): place is Place => place !== null),
    [expenses.rows],
  );

  const maps = useMemo(() => loadMaps(), []);
  const loading = group.isLoading || expenses.isLoading;

  const openInMaps = (place: Place): void => {
    void Linking.openURL(mapsUrl(place.location));
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.tripMap.title}</Text>
            <Text variant="micro" tone="muted">
              {group.data?.name}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {loading ? (
          <InsightsSkeleton />
        ) : places.length === 0 ? (
          <EmptyState title={t.tripMap.empty} body={t.tripMap.emptyBody} />
        ) : (
          <>
            {maps ? <EmbeddedMap maps={maps} places={places} radius={theme.radius.lg} /> : null}

            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="subheading">{t.tripMap.places}</Text>
              <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
                {places.map((place) => (
                  <Pressable
                    key={place.id}
                    onPress={() => openInMaps(place)}
                    accessibilityRole="button"
                    accessibilityLabel={`${place.location.name ?? coordLabel(place.location)} — ${t.tripMap.openInMaps}`}
                    style={{
                      paddingVertical: theme.spacing.md,
                      gap: theme.spacing.md,
                      flexDirection: 'row',
                      alignItems: 'center',
                    }}
                  >
                    <Ionicons
                      name="location-outline"
                      size={iconSize.md}
                      color={theme.color.brand}
                    />
                    <View style={{ flex: 1 }}>
                      <Text variant="body" numberOfLines={1}>
                        {place.location.name ?? coordLabel(place.location)}
                      </Text>
                      <Text variant="micro" tone="muted" numberOfLines={1}>
                        {place.description}
                      </Text>
                    </View>
                    <MoneyText
                      amount={place.amountMinor}
                      currency={place.currency}
                      locale={locale}
                      variant="caption"
                    />
                  </Pressable>
                ))}
              </Card>
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

/**
 * The embedded native map. Isolated in its own component so the lazy-required
 * components are only ever referenced when the module actually loaded.
 */
function EmbeddedMap({
  maps,
  places,
  radius,
}: {
  maps: MapModule;
  places: readonly Place[];
  radius: number;
}) {
  const MapView = maps.default;
  const Marker = maps.Marker;
  const region = useMemo(() => regionFor(places), [places]);
  return (
    <View style={{ height: 280, borderRadius: radius, overflow: 'hidden' }}>
      <MapView style={{ flex: 1 }} initialRegion={region}>
        {places.map((place) => (
          <Marker
            key={place.id}
            coordinate={{ latitude: place.location.lat, longitude: place.location.lng }}
            title={place.location.name ?? place.description}
            description={place.description}
          />
        ))}
      </MapView>
    </View>
  );
}
