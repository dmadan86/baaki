/**
 * Waves design tokens.
 *
 * Derived from the two reference boards: a lavender canvas, white cards with
 * softened corners and one soft shadow, a single saturated purple that owns
 * every primary action and active state, and a pastel family used to tint
 * category and stat cards.
 *
 * Cards sit at `md`. The reference boards are drawn at tablet width, where a
 * 24pt corner reads as a gentle curve; on a phone the same radius eats into a
 * card that is only a few hundred points wide and the panel starts to look
 * like a pill. Pills are for things you tap.
 *
 * Money colour is semantic and global, never decorative: owed-to-you is always
 * the periwinkle/blue pair, you-owe is always the pink/red pair. Nothing else in
 * the app is allowed to use those two colours.
 *
 * The palette is deliberately green-free (and free of blue-green/teal): the
 * brand wears a 2025 neon-indigo/violet, the paired accent a warm sunset coral,
 * owed-money a calm blue, and owed-by-you the raspberry red. "Good" money reads
 * blue rather than green, so nothing on any surface — dashboard included — needs
 * a green.
 */

export const palette = {
  brand50: '#F5F2FF',
  brand100: '#E9E4FF',
  brand200: '#D4CBFF',
  brand300: '#B4A5FB',
  brand400: '#9880F9',
  brand500: '#7A5AF8',
  brand600: '#6C4EE3',
  brand700: '#5638C4',

  ink900: '#14142B',
  ink700: '#2E2F45',
  ink500: '#54566B',
  ink400: '#7B7B8F',
  ink300: '#A8A9BA',
  ink200: '#D9DAE6',
  ink100: '#EDEDF5',

  lavender: '#F3F1FB',
  white: '#FFFFFF',

  // Two inks per pastel. `Ink` is the strong one (~7:1 on its own bg, for
  // titles and amounts); `InkMuted` is the quiet one (~4.6:1, for the subtitle
  // line under it). Both clear WCAG AA — the old single ink was faded with
  // `opacity: 0.7` for subtitles, which dropped every pastel below 3:1.
  // Pink and coral sit on very light bgs, so a title dark enough for AA plus a
  // lighter muted below it forced the ink almost to black — a harsh blood-red.
  // These two take one friendly ink instead (a dusty berry / a terracotta):
  // both clear AA on their bg, and the subtitle separates from the title by
  // weight, not by going darker. `InkMuted` mirrors `Ink` so callers are
  // unchanged. The warmer hue is drawn from the raspberry/coral reference.
  pink: '#F8D7DA',
  pinkInk: '#964450',
  pinkInkMuted: '#964450',
  peach: '#FBE0C4',
  peachInk: '#674215',
  peachInkMuted: '#8E5A1D',
  // Was a mint green; recoloured to a periwinkle so the owed-money soft (which
  // points here) is blue, not green. The key keeps its name so every caller is
  // unchanged. Both inks clear WCAG AA on the soft periwinkle bg.
  mint: '#DCE1FF',
  mintInk: '#2E3A8C',
  mintInkMuted: '#3B47A0',
  lilac: '#DCD9FB',
  lilacInk: '#413792',
  lilacInkMuted: '#4B3FA8',
  coral: '#FFC5C5',
  coralInk: '#963B2F',
  coralInkMuted: '#963B2F',
  sky: '#CFE6FA',
  skyInk: '#154C77',
  skyInkMuted: '#1D68A3',

  // Owed-to-you money. A calm blue rather than a green — "good" money still
  // reads unmistakably apart from the raspberry "money leaving" below, and the
  // palette stays green-free. Clear of the indigo brand (darker, more violet)
  // and of the sky pastel (much lighter).
  positive: '#2563EB',
  // Raspberry-leaning red (hue near the #F04770 reference) — friendlier than
  // the old fire-engine #E5484D, still unmistakably "money leaving" and clear
  // of the warning orange.
  negative: '#E84A66',
  warning: '#D98218',

  night900: '#0E0E1A',
  night800: '#16162A',
  night700: '#1E1E36',
  night600: '#2A2A47',
} as const;

/**
 * The brand wash, dark corner to light.
 *
 * Three stops off the existing brand ramp rather than new colours: a gradient
 * is a way of drawing the brand, not a second brand. Every stop is dark enough
 * to hold white text, because the balance and its labels sit on all of them.
 */
export const gradients = {
  // The brand wash — a 2025 neon-indigo/violet, deepened across three stops so
  // white text and the small balance labels stay legible on every corner. No
  // green anywhere: the neutral balance deck and the primary action tile both
  // wear this, so the dashboard opens on indigo, never green.
  light: ['#4326A6', '#5B3FD1', '#6C4EE3'],
  dark: ['#2E1E6B', '#4326A6', '#5B3FD1'],
  // The paired action tile: a warm sunset coral, the "warm highlight over a cool
  // base" of the 2025 palettes. Kept off the money hues (blue/red) and off
  // warning amber (deeper, more orange-brown) so it never reads as a status.
  // Every stop holds white.
  accentLight: ['#C2410C', '#EA580C', '#F97316'],
  accentDark: ['#7C2D12', '#B4471C', '#EA580C'],
  // The balance card wears its verdict: a blue wash when the net is in your
  // favour, a red one when you owe. Both are the money hues (positive/negative)
  // deepened across three stops so the white balance and its small labels stay
  // legible on every corner — the same rule the brand wash follows above. The
  // neutral, all-settled state keeps the brand wash, so colour only ever
  // appears when there is a debt to point at. Blue, not teal — no blue-green.
  positiveLight: ['#1E3A8A', '#1D4ED8', '#2563EB'],
  positiveDark: ['#13275E', '#1E40AF', '#2563EB'],
  negativeLight: ['#8C1D3F', '#B01D50', '#D22C63'],
  negativeDark: ['#611228', '#8C1D3F', '#A81F4C'],
} as const;

/** The pastel family, in the order groups cycle through it. */
export const tints = ['lilac', 'pink', 'mint', 'peach', 'sky', 'coral'] as const;
export type TintName = (typeof tints)[number];

export const radius = {
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  pill: 999,
} as const;

/**
 * Icon glyph sizes — the `size` a vector icon (Ionicons, etc.) is drawn at.
 * A named scale so a screen asks for `iconSize.lg`, not a bare `20` nobody can
 * find or keep consistent. These are icon sizes only; avatar/photo/badge
 * dimensions are component props, not this scale.
 */
export const iconSize = {
  micro: 10,
  xs: 12,
  sm: 14,
  base: 16,
  md: 18,
  lg: 20,
  xl: 22,
  xxl: 24,
  xxxl: 26,
  jumbo: 30,
  huge: 36,
  hero: 40,
} as const;

/** 4px base scale. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const typography = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '700' },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
  heading: { fontSize: 19, lineHeight: 25, fontWeight: '700' },
  subheading: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '500' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
  micro: { fontSize: 11, lineHeight: 15, fontWeight: '600' },
} as const;

export const shadow = {
  soft: {
    shadowColor: '#1E1450',
    shadowOpacity: 0.08,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  lifted: {
    shadowColor: '#1E1450',
    shadowOpacity: 0.16,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 10,
  },
} as const;

export const duration = {
  fast: 140,
  normal: 220,
} as const;
