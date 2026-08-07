/**
 * Two charts, drawn with rectangles.
 *
 * TDR §8 names victory-native. That library now renders through Skia, which is
 * a second native module in a build that already carries five — another
 * prebuild, another 20MB, another thing that can fail to load and take the app
 * down with it. What it would buy is animation and axes on two charts that are
 * a list of bars and a row of columns. Plain views draw both, run on the web
 * export, and cannot fail at launch.
 *
 * Both take **already-summed** rows and never do arithmetic on money: the
 * caller adds up minor units in bigint and hands over the totals. A chart that
 * did its own maths in floating point would eventually disagree with the
 * ledger, and this is the one screen where a wrong number looks like a fact.
 */

import { View, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';
import type { TintName } from '../tokens';

export interface BarDatum {
  key: string;
  label: string;
  /** Minor units. Bar widths come from the ratio, never from a float total. */
  value: bigint;
  /** Rendered money, already formatted by the caller. */
  formatted: string;
  tint?: TintName;
  /** Drawn at the left of the row — a category icon, usually. */
  leading?: React.ReactNode;
}

/**
 * A ranked list of bars: the shape a "where did it go" answer takes.
 *
 * Sorted by the caller, not here — the order is a decision about meaning, and
 * a component that quietly re-sorted would fight whoever made it.
 */
export function BarList({
  data,
  style,
  accessibilityLabelFor,
}: {
  data: readonly BarDatum[];
  style?: ViewStyle;
  accessibilityLabelFor?: (datum: BarDatum) => string;
}) {
  const theme = useTheme();
  const largest = data.reduce((max, datum) => (datum.value > max ? datum.value : max), 0n);

  return (
    <View style={[{ gap: theme.spacing.md }, style]}>
      {data.map((datum) => {
        // Integer percent from bigint: no float ever touches the money.
        const percent = largest > 0n ? Number((datum.value * 100n) / largest) : 0;
        const tint = theme.tint[datum.tint ?? 'lilac'];
        return (
          <View
            key={datum.key}
            accessible
            accessibilityLabel={
              accessibilityLabelFor?.(datum) ?? `${datum.label}: ${datum.formatted}`
            }
            style={{ gap: 6 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
              {datum.leading}
              <Text variant="caption" numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
                {datum.label}
              </Text>
              <Text variant="caption" tabular tone="muted">
                {datum.formatted}
              </Text>
            </View>
            <View
              style={{
                height: 8,
                borderRadius: theme.radius.pill,
                backgroundColor: theme.color.surfaceMuted,
                overflow: 'hidden',
              }}
            >
              {/* A row that rounds to nothing still gets a sliver: "almost
                  none" and "none" are different answers. */}
              <View
                style={{
                  width: `${datum.value > 0n ? Math.max(percent, 2) : 0}%`,
                  height: '100%',
                  borderRadius: theme.radius.pill,
                  backgroundColor: tint.ink,
                }}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

export interface ColumnDatum {
  key: string;
  label: string;
  value: bigint;
  formatted: string;
}

/** Months across the bottom, height by amount. */
export function ColumnChart({
  data,
  height = 120,
  style,
}: {
  data: readonly ColumnDatum[];
  height?: number;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const largest = data.reduce((max, datum) => (datum.value > max ? datum.value : max), 0n);

  return (
    <View style={[{ gap: theme.spacing.sm }, style]}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: theme.spacing.sm,
          height,
        }}
      >
        {data.map((datum) => {
          const percent = largest > 0n ? Number((datum.value * 100n) / largest) : 0;
          return (
            <View
              key={datum.key}
              accessible
              accessibilityLabel={`${datum.label}: ${datum.formatted}`}
              style={{ flex: 1, justifyContent: 'flex-end', gap: 4 }}
            >
              <Text variant="micro" tone="muted" align="center" numberOfLines={1}>
                {datum.formatted}
              </Text>
              {/* Capped, and centred in its share of the row. A group with one
                  month would otherwise get a single column the width of the
                  phone, which reads as a design mistake rather than as data. */}
              <View style={{ alignItems: 'center' }}>
                <View
                  style={{
                    width: '100%',
                    maxWidth: 56,
                    height: Math.max((percent / 100) * (height - 34), datum.value > 0n ? 4 : 0),
                    borderRadius: theme.radius.sm,
                    backgroundColor: theme.color.brand,
                  }}
                />
              </View>
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
        {data.map((datum) => (
          <Text key={datum.key} variant="micro" tone="faint" align="center" style={{ flex: 1 }}>
            {datum.label}
          </Text>
        ))}
      </View>
    </View>
  );
}
