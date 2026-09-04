/**
 * A meter for how much image storage this account has used (A44).
 *
 * Free accounts hold up to a ceiling (`app_config.free_storage_cap_bytes`, 10 MB)
 * of photos and receipts; this shows how close to it they are and routes to the
 * upgrade when it is full. A paid account is uncapped, so it gets a plain
 * "Unlimited" statement rather than a bar that would always read empty.
 *
 * The figure is a live server read (`waves_my_storage_usage`), not the local
 * mirror: byte accounting lives only server-side, where the cap is enforced, so
 * there is nothing on-device to reconcile it against.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';

import {
  Button,
  Card,
  directionalIcon,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { canUploadGroupPhoto, myStorageUsage } from '@/data/api';
import { formatBytes } from '@/lib/bytes';
import { useStrings } from '@/i18n';
import { SkeletonList } from '@/components/Skeletons';
import { r2Enabled } from '@/lib/storage';

export default function StorageUsageScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();

  // "Am I paid" over the same SECURITY DEFINER path the photo gate uses
  // (`canUploadGroupPhoto(null)`, A39) — a paid account is uncapped, so the meter
  // becomes an "Unlimited" statement instead of a bar. `undefined` while loading.
  const paid = useQuery({
    queryKey: ['is-paid-storage'],
    queryFn: () => canUploadGroupPhoto(null),
  });
  // If the paid-status read fails outright (no cached answer), fall back to
  // "free" so the screen resolves — otherwise `isPaid` stays undefined forever,
  // the skeleton never exits, and the usage query below is left disabled. Free is
  // the safe default: the meter shows, and the cap is enforced server-side anyway.
  const isPaid = paid.data ?? (paid.isError ? false : undefined);

  // The meter only means anything once storage is on R2, where per-user bytes are
  // tracked; before that there is no tally to show. It is also pointless for a
  // paid account, which is never charged bytes — so the query only runs for a
  // free account with R2 live.
  const shouldMeasure = r2Enabled() && isPaid === false;
  const usage = useQuery({
    queryKey: ['storage-usage'],
    queryFn: myStorageUsage,
    enabled: shouldMeasure,
  });

  const header = (
    <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
      <IconButton label={t.common.back} onPress={() => router.back()}>
        <Ionicons
          name={directionalIcon('chevron-back')}
          size={iconSize.lg}
          color={theme.color.text}
        />
      </IconButton>
      <View style={{ flex: 1, alignItems: 'center' }}>
        <Text variant="heading">{t.storage.title}</Text>
      </View>
      <View style={{ width: 44 }} />
    </Row>
  );

  const body = () => {
    // Paid, or R2 not yet live: no ceiling applies, so state it plainly rather
    // than drawing an empty bar.
    if (isPaid === undefined) return <SkeletonList rows={2} />;
    if (isPaid || !r2Enabled()) {
      return (
        <Card style={{ gap: theme.spacing.sm }}>
          <Row style={{ gap: theme.spacing.sm }}>
            <Ionicons name="infinite" size={iconSize.lg} color={theme.color.brand} />
            <Text variant="subheading">{t.storage.unlimited}</Text>
          </Row>
          <Text variant="body" tone="muted">
            {t.storage.unlimitedBody}
          </Text>
        </Card>
      );
    }

    // A failed read must not sit as a skeleton forever — offer a retry. But a
    // refetch that fails while an earlier read still holds data keeps showing the
    // (stale) meter rather than blanking it: only a failure with nothing cached
    // becomes the error card.
    if (usage.isError && !usage.data) {
      return (
        <Card style={{ gap: theme.spacing.sm }}>
          <Text variant="subheading">{t.loadError}</Text>
          <Text variant="body" tone="muted">
            {t.loadErrorBody}
          </Text>
          <Button label={t.retry} fullWidth onPress={() => usage.refetch()} />
        </Card>
      );
    }

    if (usage.isLoading || !usage.data) return <SkeletonList rows={2} />;

    const { usedBytes, capBytes } = usage.data;
    const fraction = capBytes > 0 ? usedBytes / capBytes : 0;
    const percent = Math.min(100, Math.round(fraction * 100));
    const full = usedBytes >= capBytes && capBytes > 0;
    const fill = full ? theme.color.negative : theme.color.brand;

    return (
      <Card style={{ gap: theme.spacing.md }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text variant="subheading">
            {t.storage.usedOfCap
              .replace('{used}', formatBytes(usedBytes, locale))
              .replace('{cap}', formatBytes(capBytes, locale))}
          </Text>
          <Text variant="caption" tone={full ? 'negative' : 'muted'}>
            {t.storage.percentUsed.replace('{percent}', String(percent))}
          </Text>
        </Row>

        {/* The bar. A flex row so the fill grows from the writing start — left in
            LTR, right in RTL — without any manual direction handling. */}
        <View
          style={{
            flexDirection: 'row',
            height: 12,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.color.surfaceMuted,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${Math.max(percent, usedBytes > 0 ? 4 : 0)}%`,
              backgroundColor: fill,
              borderRadius: theme.radius.pill,
            }}
          />
        </View>

        <Text variant="body" tone={full ? 'negative' : 'muted'}>
          {full
            ? t.storage.full
            : t.storage.freeBody.replace('{cap}', formatBytes(capBytes, locale))}
        </Text>

        <Button
          label={t.storage.upgrade}
          fullWidth
          onPress={() => router.push('/settings/upgrade')}
          icon={<Ionicons name="rocket-outline" size={iconSize.base} color={theme.color.onBrand} />}
        />
      </Card>
    );
  };

  return (
    <Screen>
      {header}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          paddingTop: theme.spacing.lg,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        {body()}
      </ScrollView>
    </Screen>
  );
}
