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
 * The `Skeleton` primitive pulses on its own — that is its default.
 */

import type { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { Card, Row, Screen, Skeleton, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';

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
  return (
    <Row style={{ gap: theme.spacing.md, paddingVertical: theme.spacing.md }}>
      <Skeleton width={44} height={44} radius={theme.radius.pill} />
      <View style={{ flex: 1, gap: theme.spacing.sm }}>
        <Skeleton width="55%" height={15} />
        <Skeleton width="32%" height={12} />
      </View>
      {trailing ? <Skeleton width={64} height={18} /> : null}
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
  return (
    <Row style={{ paddingTop: theme.spacing.md, gap: theme.spacing.md }}>
      <Skeleton width={46} height={46} radius={theme.radius.pill} />
      <View style={{ flex: 1, gap: theme.spacing.sm }}>
        <Skeleton width="30%" height={12} />
        <Skeleton width="50%" height={18} />
      </View>
      <Skeleton width={40} height={40} radius={theme.radius.pill} />
    </Row>
  );
}

/** The home tab: header, the big balance panel, a groups list. */
export function HomeSkeleton() {
  const theme = useTheme();
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
        <Skeleton width="100%" height={196} radius={theme.radius.md} />
        <View style={{ gap: theme.spacing.md }}>
          <Skeleton width="40%" height={18} />
          <SkeletonList rows={3} />
        </View>
      </LoadingRegion>
    </Screen>
  );
}

/** A group: header, balance card, and the expense list. */
export function GroupSkeleton() {
  const theme = useTheme();
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
        <Skeleton width="100%" height={150} radius={theme.radius.md} />
        <Row style={{ gap: theme.spacing.sm }}>
          <Skeleton width={110} height={40} radius={theme.radius.pill} />
          <Skeleton width={110} height={40} radius={theme.radius.pill} />
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
          <Skeleton width={40} height={40} radius={theme.radius.pill} />
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Skeleton width="40%" height={18} />
          </View>
          <View style={{ width: 40 }} />
        </Row>
        <View style={{ gap: theme.spacing.md }}>
          <Skeleton width="35%" height={16} />
          <SkeletonList rows={rows} trailing={trailing} />
        </View>
      </LoadingRegion>
    </Screen>
  );
}

/**
 * The friends tab: the two balance sections — owed to you, and what you owe —
 * each a heading and a short list.
 *
 * Shaped to `FriendsSection` down to the pixel so the swap to real content is a
 * fill, not a jump. The loaded list is drawn as bare rows on the screen with a
 * hairline between — *not* inside a Card — so this must be too: an earlier
 * version wrapped the rows in `SkeletonList` (a Card with an `lg` inset and a
 * shadow), and on load that surface, its rounded corners and the inset all
 * vanished at once while every row slid left. The heading matches the real
 * 19px `heading` and carries the same `marginBottom` the section header does,
 * and the per-currency footnote holds its place at the foot. Shown in place of
 * the "all square" empty state, which is a verdict the query has not returned.
 */
export function PeopleSkeleton() {
  const theme = useTheme();
  return (
    <LoadingRegion style={{ gap: theme.spacing.xl }}>
      {[0, 1].map((section) => (
        <View key={section} style={{ gap: theme.spacing.md }}>
          {/* The section heading: the same 19px height as `SectionHeader`'s
              `heading` text, and its `marginBottom` too, so the gap down to the
              first row is identical and the list does not lift on load. */}
          <Skeleton width="35%" height={19} style={{ marginBottom: theme.spacing.md }} />
          {/* Bare rows on the screen with a hairline between — exactly how
              `FriendsSection` draws the loaded list. No Card. */}
          <View>
            {[0, 1].map((row, index, all) => (
              <View key={row}>
                <SkeletonRow />
                {index < all.length - 1 ? (
                  <View style={{ height: 1, backgroundColor: theme.color.border }} />
                ) : null}
              </View>
            ))}
          </View>
        </View>
      ))}
      {/* The per-currency footnote holds its spot so nothing shifts up under it
          when the real note arrives. */}
      <Skeleton width="70%" height={11} radius={theme.radius.sm} style={{ alignSelf: 'center' }} />
    </LoadingRegion>
  );
}

/**
 * The activity tab, shaped to the real feed so the swap is a fill, not a jump.
 * The feed is now a flat list of rows under day headings — a 40×40 tinted tile,
 * the sentence and its trailing amount beside it, the relative time beneath —
 * with hairline separators between rows. No timeline rail (an earlier design had
 * one; drawing it here made the whole shape lurch when the railless feed
 * arrived). The leading day-heading bar, the tile size, the `md` vertical
 * padding and the hairline all match `ActivityScreen`'s row so nothing moves
 * when the query returns. Shown in place of the "nothing yet" empty state, which
 * is a verdict the query has not returned yet.
 */
export function FeedSkeleton({ rows = 6 }: { rows?: number }) {
  const theme = useTheme();
  return (
    <LoadingRegion>
      {/* Stands in for the uppercase day heading the first section renders, at
          its 11px height and the same lg/md margins — so the first real heading
          does not push the rows down. */}
      <Skeleton
        width="28%"
        height={11}
        style={{ marginTop: theme.spacing.lg, marginBottom: theme.spacing.md }}
      />
      {Array.from({ length: rows }, (_, index) => {
        const isLast = index === rows - 1;
        return (
          <View key={index}>
            <Row
              style={{
                gap: theme.spacing.md,
                alignItems: 'center',
                paddingVertical: theme.spacing.md,
              }}
            >
              <Skeleton width={40} height={40} radius={theme.radius.md} />
              <View style={{ flex: 1, gap: theme.spacing.sm }}>
                {/* The sentence line, then the smaller relative-time line. */}
                <Skeleton width="86%" height={15} />
                <Skeleton width="34%" height={11} />
              </View>
              <Skeleton width={56} height={16} />
            </Row>
            {!isLast ? <View style={{ height: 1, backgroundColor: theme.color.border }} /> : null}
          </View>
        );
      })}
    </LoadingRegion>
  );
}

/**
 * The captures inbox: day headings over a stack of capture cards, each a
 * thumbnail beside an amount, a description line and a date, then an
 * assign/delete action row underneath. Shaped to `CapturesScreen`'s real
 * `Card` down to the pixel — same `xl` card padding and `md` internal gap,
 * the same 46px thumbnail corner (`radius.sm`, not a pill: a receipt photo is
 * a small rectangle, not an avatar), the same three text lines at their real
 * variants (`subheading` for the amount, `caption` for the description,
 * `micro` for the date) — so the swap to real cards is a fill, not a jump.
 * The action row stands in for the `sm` Assign button (38px, pill radius) and
 * the 44px delete `IconButton`, whose icon is the only thing skeletoned since
 * the button chrome itself is invisible until pressed. Two day sections of
 * two cards each is enough to read as "a short list", the same restraint
 * `PeopleSkeleton` uses. Shown in place of the "nothing yet" empty state,
 * which is a verdict the local mirror has not hydrated yet (ADR-005).
 */
export function InboxSkeleton() {
  const theme = useTheme();
  return (
    <LoadingRegion style={{ gap: theme.spacing.lg }}>
      {[0, 1].map((section) => (
        <View key={section} style={{ gap: theme.spacing.md }}>
          <Skeleton width="28%" height={11} style={{ marginBottom: theme.spacing.xs }} />
          {[0, 1].map((card) => (
            <Card key={card} style={{ gap: theme.spacing.md }}>
              <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
                <Skeleton width={46} height={46} radius={theme.radius.sm} />
                <View style={{ flex: 1, gap: theme.spacing.sm }}>
                  <Skeleton width="45%" height={16} />
                  <Skeleton width="65%" height={13} />
                  <Skeleton width="30%" height={11} />
                </View>
              </Row>
              <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
                <Skeleton width="100%" height={38} radius={theme.radius.pill} style={{ flex: 1 }} />
                <View
                  style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Skeleton width={22} height={22} radius={theme.radius.sm} />
                </View>
              </Row>
            </Card>
          ))}
        </View>
      ))}
    </LoadingRegion>
  );
}

/** Insights: a heading and a couple of chart-sized blocks. */
export function InsightsSkeleton() {
  const theme = useTheme();
  return (
    <LoadingRegion style={{ gap: theme.spacing.xl }}>
      <Skeleton width="45%" height={18} />
      <Skeleton width="100%" height={180} radius={theme.radius.md} />
      <SkeletonList rows={4} />
    </LoadingRegion>
  );
}
