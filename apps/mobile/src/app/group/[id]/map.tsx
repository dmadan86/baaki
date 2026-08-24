/**
 * The trip's places: every expense that carries a location, as a tappable list
 * that opens the spot in the phone's own maps app.
 *
 * A read of the ledger the phone already mirrors (ADR-005) — no fetch, works
 * offline, and it lists only what the reader is already allowed to see (RLS
 * dropped the rest before it ever reached the device). It never asks for the
 * phone's own location; these are expense places, not "where am I".
 *
 * Deliberately NOT an embedded map. A native map module (`react-native-maps`)
 * is not a dependency of this app, and adding an unverifiable native dependency
 * is a known way to break a build in a way JS-only CI never catches. So this
 * hands off to the OS maps app via `mapsUrl` instead — honest and useful today.
 * To add an in-app map later: add `react-native-maps` + its config plugin, then
 * render pins behind a lazy, non-throwing require (the native-module rule) with
 * this list as the fallback.
 */

import { useMemo } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { Linking, Pressable, ScrollView, View } from 'react-native';

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

export default function PlacesScreen() {
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
                <Ionicons name="location-outline" size={iconSize.md} color={theme.color.brand} />
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
                <Ionicons
                  name={directionalIcon('chevron-forward')}
                  size={iconSize.sm}
                  color={theme.color.textFaint}
                />
              </Pressable>
            ))}
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}
