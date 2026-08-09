/**
 * Screen-shaped placeholders.
 *
 * The rule these follow: a skeleton is only worth showing where the person
 * would otherwise wait looking at nothing, and it should be the shape of what
 * is coming so the swap to real content is a fill, not a jump. A spinner in the
 * middle of a blank screen answers "is it working"; a skeleton answers "what is
 * loading", which on a screen full of a person's money is the better answer.
 *
 * These are not used for the few-millisecond flash while the local mirror
 * hydrates on a warm screen — a placeholder that appears and vanishes inside a
 * frame is worse than the content simply being there. They are for the cold
 * launch, where the whole shell is empty, and for the screens that genuinely
 * wait on the network: the inbox, spending, plan and receipt screens.
 *
 * Motion comes from the app's own preference, not the OS setting alone, because
 * somebody can turn motion off inside Baaki on a phone that never asked. The
 * `Skeleton` primitive itself knows nothing about that; it is told.
 */

import type { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { Card, Row, Screen, Skeleton, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';
import { useMotion } from '@/lib/motion';

/** Marks a subtree as one loading region a screen reader announces once, not row by row. */
function LoadingRegion({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const { t } = useStrings();
  return (
    <View
      accessible
      accessibilityLabel={t.common.loading}
      accessibilityRole="progressbar"
      style={style}
    >
      {children}
    </View>
  );
}

/** One list row: a round avatar, a title line, a shorter subtitle, an amount on the end. */
export function SkeletonRow({ trailing = true }: { trailing?: boolean }) {
  const theme = useTheme();
  const { animated } = useMotion();
  return (
    <Row style={{ gap: theme.spacing.md, paddingVertical: theme.spacing.md }}>
      <Skeleton width={44} height={44} radius={theme.radius.pill} animated={animated} />
      <View style={{ flex: 1, gap: theme.spacing.sm }}>
        <Skeleton width="55%" height={15} animated={animated} />
        <Skeleton width="32%" height={12} animated={animated} />
      </View>
      {trailing ? <Skeleton width={64} height={18} animated={animated} /> : null}
    </Row>
  );
}

/** A card of rows with hairlines between them, the way the real lists are drawn. */
export function SkeletonList({ rows = 4, trailing = true }: { rows?: number; trailing?: boolean }) {
  const theme = useTheme();
  return (
    <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
      {Array.from({ length: rows }, (_, index) => (
        <View key={index}>
          <SkeletonRow trailing={trailing} />
          {index < rows - 1 ? (
            <View style={{ height: 1, backgroundColor: theme.color.border }} />
          ) : null}
        </View>
      ))}
    </Card>
  );
}

/** Header block used by the tabs: an avatar, a greeting line, a name. */
function SkeletonHeader() {
  const theme = useTheme();
  const { animated } = useMotion();
  return (
    <Row style={{ paddingTop: theme.spacing.md, gap: theme.spacing.md }}>
      <Skeleton width={46} height={46} radius={theme.radius.pill} animated={animated} />
      <View style={{ flex: 1, gap: theme.spacing.sm }}>
        <Skeleton width="30%" height={12} animated={animated} />
        <Skeleton width="50%" height={18} animated={animated} />
      </View>
      <Skeleton width={40} height={40} radius={theme.radius.pill} animated={animated} />
    </Row>
  );
}

/** The home tab: header, the big balance panel, a groups list. */
export function HomeSkeleton() {
  const theme = useTheme();
  const { animated } = useMotion();
  return (
    <Screen>
      <LoadingRegion
        style={{
          flex: 1,
          paddingHorizontal: theme.spacing.xl,
          gap: theme.spacing.xl,
        }}
      >
        <SkeletonHeader />
        <Skeleton width="100%" height={196} radius={theme.radius.md} animated={animated} />
        <View style={{ gap: theme.spacing.md }}>
          <Skeleton width="40%" height={18} animated={animated} />
          <SkeletonList rows={3} />
        </View>
      </LoadingRegion>
    </Screen>
  );
}

/** A group: header, balance card, and the expense list. */
export function GroupSkeleton() {
  const theme = useTheme();
  const { animated } = useMotion();
  return (
    <Screen>
      <LoadingRegion
        style={{
          flex: 1,
          paddingHorizontal: theme.spacing.xl,
          gap: theme.spacing.xl,
        }}
      >
        <SkeletonHeader />
        <Skeleton width="100%" height={150} radius={theme.radius.md} animated={animated} />
        <Row style={{ gap: theme.spacing.sm }}>
          <Skeleton width={110} height={40} radius={theme.radius.pill} animated={animated} />
          <Skeleton width={110} height={40} radius={theme.radius.pill} animated={animated} />
        </Row>
        <SkeletonList rows={4} />
      </LoadingRegion>
    </Screen>
  );
}

/**
 * A back-headed content screen — the inbox, plan, member list. A header with a
 * back button and a title, a section heading, then a list.
 */
export function ListScreenSkeleton({
  rows = 5,
  trailing = true,
}: {
  rows?: number;
  trailing?: boolean;
}) {
  const theme = useTheme();
  const { animated } = useMotion();
  return (
    <Screen>
      <LoadingRegion
        style={{
          flex: 1,
          paddingHorizontal: theme.spacing.xl,
          gap: theme.spacing.xl,
        }}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <Skeleton width={40} height={40} radius={theme.radius.pill} animated={animated} />
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Skeleton width="40%" height={18} animated={animated} />
          </View>
          <View style={{ width: 40 }} />
        </Row>
        <View style={{ gap: theme.spacing.md }}>
          <Skeleton width="35%" height={16} animated={animated} />
          <SkeletonList rows={rows} trailing={trailing} />
        </View>
      </LoadingRegion>
    </Screen>
  );
}

/** Insights: a heading and a couple of chart-sized blocks. */
export function InsightsSkeleton() {
  const theme = useTheme();
  const { animated } = useMotion();
  return (
    <LoadingRegion style={{ gap: theme.spacing.xl }}>
      <Skeleton width="45%" height={18} animated={animated} />
      <Skeleton width="100%" height={180} radius={theme.radius.md} animated={animated} />
      <SkeletonList rows={4} />
    </LoadingRegion>
  );
}
