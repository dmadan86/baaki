import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import { gradients, palette, radius, shadow, spacing, typography, type TintName } from './tokens';

export interface TintPair {
  readonly bg: string;
  /** Strong ink (~7:1 on `bg`) — titles, amounts, icons. */
  readonly ink: string;
  /** Quiet ink (~4.6:1 on `bg`) — the subtitle line. Both clear WCAG AA. */
  readonly inkMuted: string;
}

export interface Theme {
  readonly scheme: 'light' | 'dark';
  readonly color: {
    readonly bg: string;
    readonly surface: string;
    readonly surfaceMuted: string;
    readonly border: string;
    readonly text: string;
    readonly textMuted: string;
    readonly textFaint: string;
    readonly brand: string;
    readonly brandPressed: string;
    readonly brandSoft: string;
    readonly onBrand: string;
    /** The fill of a primary button. A near-black, separate from the purple
        `brand` accent: buttons are ink, links and glyphs stay brand. */
    readonly buttonPrimary: string;
    readonly buttonPrimaryPressed: string;
    readonly onButtonPrimary: string;
    /** The bar a skeleton placeholder is painted in — a shade off the surface it sits on. */
    readonly skeleton: string;
    /** Semantic money colours — see tokens.ts. */
    readonly positive: string;
    readonly positiveSoft: string;
    readonly negative: string;
    readonly negativeSoft: string;
    readonly warning: string;
    readonly warningSoft: string;
  };
  readonly gradient: {
    /** Stops for the brand wash, in paint order. */
    readonly brand: readonly string[];
    /** A second, blue wash for the paired action tile. */
    readonly accent: readonly string[];
    /** Green wash for a balance in your favour. */
    readonly positive: readonly string[];
    /** Red wash for a balance you owe. */
    readonly negative: readonly string[];
  };
  readonly tint: Readonly<Record<TintName, TintPair>>;
  readonly radius: typeof radius;
  readonly spacing: typeof spacing;
  readonly typography: typeof typography;
  readonly shadow: typeof shadow;
}

const lightTints: Record<TintName, TintPair> = {
  lilac: { bg: palette.lilac, ink: palette.lilacInk, inkMuted: palette.lilacInkMuted },
  pink: { bg: palette.pink, ink: palette.pinkInk, inkMuted: palette.pinkInkMuted },
  mint: { bg: palette.mint, ink: palette.mintInk, inkMuted: palette.mintInkMuted },
  peach: { bg: palette.peach, ink: palette.peachInk, inkMuted: palette.peachInkMuted },
  sky: { bg: palette.sky, ink: palette.skyInk, inkMuted: palette.skyInkMuted },
  coral: { bg: palette.coral, ink: palette.coralInk, inkMuted: palette.coralInkMuted },
};

/** Dark keeps the same hues, dropped in luminance so they stay recognisable. */
const darkTints: Record<TintName, TintPair> = {
  lilac: { bg: '#2E2A57', ink: '#C9C2FF', inkMuted: '#9993CB' },
  pink: { bg: '#4A2A31', ink: '#FFC2CA', inkMuted: '#C59199' },
  mint: { bg: '#26306B', ink: '#C7CEFF', inkMuted: '#9AA1DC' },
  peach: { bg: '#463020', ink: '#F7CFA2', inkMuted: '#BB9976' },
  sky: { bg: '#1B3A52', ink: '#AFD8F7', inkMuted: '#81A7C4' },
  coral: { bg: '#4C2A28', ink: '#FFB3AE', inkMuted: '#CF8E8A' },
};

const lightTheme: Theme = {
  scheme: 'light',
  color: {
    bg: palette.lavender,
    surface: palette.white,
    surfaceMuted: palette.brand50,
    border: palette.ink100,
    text: palette.ink900,
    // One rung darker than the ramp's midtones: ink400 muted / ink300 faint
    // read at ~3.7:1 and ~2.1:1 on the lavender canvas. ink500 clears 6:1 and
    // ink400 clears 3:1, so muted body text and faint UI marks both pass AA.
    textMuted: palette.ink500,
    textFaint: palette.ink400,
    brand: '#6C4EE3',
    brandPressed: '#5638C4',
    brandSoft: '#E9E4FF',
    onBrand: palette.white,
    buttonPrimary: '#181818',
    buttonPrimaryPressed: '#2E2E2E',
    onButtonPrimary: palette.white,
    skeleton: palette.ink200,
    positive: palette.positive,
    positiveSoft: palette.mint,
    negative: palette.negative,
    negativeSoft: palette.pink,
    warning: palette.warning,
    warningSoft: palette.peach,
  },
  gradient: {
    brand: gradients.light,
    accent: gradients.accentLight,
    positive: gradients.positiveLight,
    negative: gradients.negativeLight,
  },
  tint: lightTints,
  radius,
  spacing,
  typography,
  shadow,
};

const darkTheme: Theme = {
  ...lightTheme,
  scheme: 'dark',
  color: {
    bg: palette.night900,
    surface: palette.night800,
    surfaceMuted: palette.night700,
    border: palette.night600,
    text: '#F4F3FF',
    textMuted: '#9E9EB8',
    textFaint: '#6B6B85',
    brand: '#8B6FF0',
    brandPressed: '#6C4EE3',
    brandSoft: '#2A2250',
    onBrand: palette.white,
    buttonPrimary: '#181818',
    buttonPrimaryPressed: '#2E2E2E',
    onButtonPrimary: palette.white,
    skeleton: palette.night600,
    positive: '#60A5FA',
    positiveSoft: '#17325C',
    negative: '#FF7088',
    negativeSoft: '#4A2A31',
    warning: '#E8A54B',
    warningSoft: '#463020',
  },
  gradient: {
    brand: gradients.dark,
    accent: gradients.accentDark,
    positive: gradients.positiveDark,
    negative: gradients.negativeDark,
  },
  tint: darkTints,
};

const ThemeContext = createContext<Theme>(lightTheme);

export function ThemeProvider({
  children,
  forceScheme,
}: {
  children: ReactNode;
  forceScheme?: 'light' | 'dark';
}) {
  const systemScheme = useColorScheme();
  const theme = useMemo(() => {
    const scheme = forceScheme ?? (systemScheme === 'dark' ? 'dark' : 'light');
    return scheme === 'dark' ? darkTheme : lightTheme;
  }, [forceScheme, systemScheme]);

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export { lightTheme, darkTheme };
