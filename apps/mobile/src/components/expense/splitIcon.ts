/**
 * One glyph per way of splitting a bill.
 *
 * "Equally", "Shares", "Percent" were three words in a row of identical pills —
 * nothing to aim at, and nothing to recognise afterwards on the expense screen,
 * where the same fact came back as a bare word in a labelled row. The icon is
 * what makes the two screens agree at a glance: the chip you tapped while
 * editing is the mark you see on the bill later.
 *
 * Keyed by the ledger's `split_type` (TDR §8), which is a superset of the three
 * kinds this form offers — an itemized or adjusted split is written by other
 * screens but still has to be shown here.
 */

import type Ionicons from '@expo/vector-icons/Ionicons';

type IconName = keyof typeof Ionicons.glyphMap;

const SPLIT_ICONS: Record<string, IconName> = {
  // Everyone the same: a row of people, not a maths symbol.
  equal: 'people-outline',
  // Typed amounts, one per person — money, straight.
  exact: 'cash-outline',
  // Slices of a whole.
  percent: 'pie-chart-outline',
  // Weights: bars of different heights.
  shares: 'stats-chart-outline',
  // Someone's share nudged up or down off the even split.
  adjustment: 'options-outline',
  // Line by line, off the bill itself.
  itemized: 'list-outline',
};

/** The glyph for a split type, falling back to the even-split people for a
 *  value this build does not know (a newer server writing an older client). */
export function splitIcon(splitType: string): IconName {
  return SPLIT_ICONS[splitType] ?? 'people-outline';
}
