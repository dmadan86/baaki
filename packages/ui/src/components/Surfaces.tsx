import type { ReactNode } from 'react';
import { View, type ViewProps, type ViewStyle } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';

import { useTheme } from '../theme';
import type { TintName } from '../tokens';
import { Text } from './Text';

/**
 * The safe-area padding applied as a plain `View`, read from the *hook* rather
 * than drawn by `SafeAreaView`.
 *
 * `SafeAreaView` measures its own frame to decide which edges touch the screen
 * boundary, so on a freshly mounted screen its first layout pass runs with zero
 * padding and the real inset lands a frame later — the whole screen visibly
 * drops by the status-bar height as you arrive on it (the "layout shift" on a
 * tab you have not visited this session). `useSafeAreaInsets` instead returns
 * the inset already measured by the root provider, synchronously, on the very
 * first render — so the content is placed correctly from frame one and nothing
 * jumps in. This is why finance/chat apps lay out against known insets rather
 * than a self-measuring safe-area view.
 */
function ScreenBody({
  children,
  edges,
  style,
}: {
  children: ReactNode;
  edges: readonly Edge[];
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const inset: ViewStyle = {
    paddingTop: edges.includes('top') ? insets.top : 0,
    paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
    paddingLeft: edges.includes('left') ? insets.left : 0,
    paddingRight: edges.includes('right') ? insets.right : 0,
  };
  // `style` last so a screen that sets its own padding still wins, exactly as it
  // did when this merged over `SafeAreaView`'s style.
  return (
    <View style={[{ flex: 1, backgroundColor: theme.color.bg }, inset, style]}>{children}</View>
  );
}

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
   * safe-area inside it re-measure against the modal window — and `ScreenBody`'s
   * hook then reads that inner provider's insets.
   */
  inModal?: boolean;
}) {
  const body = (
    <ScreenBody edges={edges} style={style}>
      {children}
    </ScreenBody>
  );
  return inModal ? <SafeAreaProvider>{body}</SafeAreaProvider> : body;
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
      {/* Marked as a header so a screen reader's heading navigation (the iOS
          rotor, TalkBack's heading swipe) can jump between sections — a long
          settings or group screen is a wall of rows otherwise. Purely semantic;
          nothing about the look changes. */}
      <Text variant="heading" accessibilityRole="header">
        {title}
      </Text>
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
