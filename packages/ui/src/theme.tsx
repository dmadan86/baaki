import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import { gradients, palette, radius, shadow, spacing, typography, type TintName } from './tokens';

export interface TintPair {
  readonly bg: string;
  readonly ink: string;
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
    /** The bar a skeleton placeholder is painted in — a shade off the surface it sits on. */
    readonly skeleton: string;
    /** Semantic money colours — see tokens.ts. */
    readonly positive: string;
    readonly positiveSoft: string;
    readonly negative: string;
    readonly negativeSoft: string;
  };
  readonly gradient: {
    /** Stops for the brand wash, in paint order. */
    readonly brand: readonly string[];
  };
  readonly tint: Readonly<Record<TintName, TintPair>>;
  readonly radius: typeof radius;
  readonly spacing: typeof spacing;
  readonly typography: typeof typography;
  readonly shadow: typeof shadow;
}

const lightTints: Record<TintName, TintPair> = {
  lilac: { bg: palette.lilac, ink: palette.lilacInk },
  pink: { bg: palette.pink, ink: palette.pinkInk },
  mint: { bg: palette.mint, ink: palette.mintInk },
  peach: { bg: palette.peach, ink: palette.peachInk },
  sky: { bg: palette.sky, ink: palette.skyInk },
  coral: { bg: palette.coral, ink: palette.coralInk },
};

/** Dark keeps the same hues, dropped in luminance so they stay recognisable. */
const darkTints: Record<TintName, TintPair> = {
  lilac: { bg: '#2E2A57', ink: '#C9C2FF' },
  pink: { bg: '#4A2A31', ink: '#FFC2CA' },
  mint: { bg: '#123F36', ink: '#9DE8D2' },
  peach: { bg: '#463020', ink: '#F7CFA2' },
  sky: { bg: '#1B3A52', ink: '#AFD8F7' },
  coral: { bg: '#4C2A28', ink: '#FFB3AE' },
};

const lightTheme: Theme = {
  scheme: 'light',
  color: {
    bg: palette.lavender,
    surface: palette.white,
    surfaceMuted: palette.brand50,
    border: palette.ink100,
    text: palette.ink900,
    textMuted: palette.ink400,
    textFaint: palette.ink300,
    brand: palette.brand500,
    brandPressed: palette.brand600,
    brandSoft: palette.brand100,
    onBrand: palette.white,
    skeleton: palette.ink200,
    positive: palette.positive,
    positiveSoft: palette.mint,
    negative: palette.negative,
    negativeSoft: palette.pink,
  },
  gradient: { brand: gradients.light },
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
    brand: palette.brand400,
    brandPressed: palette.brand500,
    brandSoft: '#2A2455',
    onBrand: palette.white,
    skeleton: palette.night600,
    positive: '#34D399',
    positiveSoft: '#123F36',
    negative: '#FF7B72',
    negativeSoft: '#4A2A31',
  },
  gradient: { brand: gradients.dark },
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
