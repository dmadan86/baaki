/**
 * Baaki design tokens.
 *
 * Derived from the two reference boards: a lavender canvas, white cards with
 * generous corner radii and one soft shadow, a single saturated purple that
 * owns every primary action and active state, and a pastel family used to tint
 * category and stat cards.
 *
 * Money colour is semantic and global, never decorative: owed-to-you is always
 * the mint/green pair, you-owe is always the pink/red pair. Nothing else in the
 * app is allowed to use those two colours.
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

  pink: '#F8D7DA',
  pinkInk: '#B4404A',
  peach: '#FBE0C4',
  peachInk: '#9A6220',
  mint: '#C7EDE4',
  mintInk: '#0E7A5B',
  lilac: '#DCD9FB',
  lilacInk: '#4B3FA8',
  coral: '#FFC5C5',
  coralInk: '#C0392F',
  sky: '#CFE6FA',
  skyInk: '#1E6BA8',

  positive: '#0E9F6E',
  negative: '#E5484D',
  warning: '#D98218',

  night900: '#0E0E1A',
  night800: '#16162A',
  night700: '#1E1E36',
  night600: '#2A2A47',
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
