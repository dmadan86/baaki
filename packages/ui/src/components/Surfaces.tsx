import type { ReactNode } from 'react';
import { View, type ViewProps, type ViewStyle } from 'react-native';
import { SafeAreaProvider, SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { useTheme } from '../theme';
import type { TintName } from '../tokens';
import { Text } from './Text';

export function Screen({
  children,
  edges = ['top'],
  style,
  inModal = false,
}: {
  children: ReactNode;
  edges?: readonly Edge[];
  style?: ViewStyle;
  /**
   * Set when this Screen is the root of a React Native `Modal`. A Modal renders
   * in its own native window that the app's SafeAreaProvider can't reach, so on
   * edge-to-edge Android the insets read as zero and the content slides under
   * the status bar. Wrapping the modal's Screen in its own provider makes the
   * safe-area inside it re-measure against the modal window.
   */
  inModal?: boolean;
}) {
  const theme = useTheme();
  const screen = (
    <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor: theme.color.bg }, style]}>
      {children}
    </SafeAreaView>
  );
  return inModal ? <SafeAreaProvider>{screen}</SafeAreaProvider> : screen;
}

export interface CardProps extends ViewProps {
  children: ReactNode;
  padded?: boolean;
  /** Flat cards sit inside another card or a list; they drop the shadow. */
  flat?: boolean;
}

export function Card({ children, padded = true, flat = false, style, ...rest }: CardProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.color.surface,
          borderRadius: theme.radius.md,
          padding: padded ? theme.spacing.xl : 0,
        },
        !flat && theme.shadow.soft,
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

/**
 * The pastel category card from the reference boards. It keeps its own flat,
 * shadowless look, so it does not take `padded`/`flat` from `CardProps`.
 */
export function TintCard({
  tint,
  children,
  style,
  ...rest
}: Omit<CardProps, 'padded' | 'flat'> & { tint: TintName }) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.tint[tint].bg,
          borderRadius: theme.radius.md,
          padding: theme.spacing.lg,
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: theme.spacing.md,
      }}
    >
      <Text variant="heading">{title}</Text>
      {action}
    </View>
  );
}

export function Divider() {
  const theme = useTheme();
  return <View style={{ height: 1, backgroundColor: theme.color.border }} />;
}

export function Row({
  children,
  gap = 12,
  style,
  ...rest
}: ViewProps & { children: ReactNode; gap?: number }) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]} {...rest}>
      {children}
    </View>
  );
}
