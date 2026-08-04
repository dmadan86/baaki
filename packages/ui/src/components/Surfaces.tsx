import type { ReactNode } from 'react';
import { View, type ViewProps, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { useTheme } from '../theme';
import type { TintName } from '../tokens';
import { Text } from './Text';

export function Screen({
  children,
  edges = ['top'],
  style,
}: {
  children: ReactNode;
  edges?: readonly Edge[];
  style?: ViewStyle;
}) {
  const theme = useTheme();
  return (
    <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor: theme.color.bg }, style]}>
      {children}
    </SafeAreaView>
  );
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
          borderRadius: theme.radius.xl,
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

/** The pastel category card from the reference boards. */
export function TintCard({ tint, children, style, ...rest }: CardProps & { tint: TintName }) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.tint[tint].bg,
          borderRadius: theme.radius.xl,
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
