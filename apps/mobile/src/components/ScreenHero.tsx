/**
 * The panel every important screen opens with.
 *
 * A group opens on a saturated gradient that runs up under the status bar,
 * carries the name of the thing you are looking at, one number that is the
 * whole point of the screen, and the actions that number invites. The
 * dashboard opens the same way. Review and Bank messages did not — they opened
 * on a plain white row with a small glyph, which is the layout of a settings
 * page, and it made two of the app's three busiest screens look like somewhere
 * you had wandered into by accident.
 *
 * So the shape is extracted rather than copied a third and fourth time. What
 * lives here is the *shell* and the two controls that sit on it:
 *
 *   - `ScreenHero` — the gradient, the safe-area inset, the rounded bottom, and
 *     the top row (an optional back chevron, the identity glyph and name, a
 *     line of state under it, and the small white glyph actions on the end).
 *     Everything below that is the caller's: a balance, a count, a total, a
 *     search field.
 *   - `HeroPillButton` — the white pill whose label is drawn in the gradient's
 *     own darkest stop, which is why it takes the stops rather than a colour.
 *   - `HeroActionCircle` — the dim white disc a secondary glyph sits on.
 *
 * Both controls were `GroupHero`'s and are now shared with it, so a change to
 * how a hero action looks reaches every hero rather than one of them.
 *
 * The panel is deliberately *not* a `Screen` header or a navigation option: it
 * scrolls with nothing, sits above the list, and the screens that use it pass
 * `edges={[]}` so it can run under the status bar the way the dashboard's does.
 */

import type { ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { directionalIcon, Gradient, iconSize, Row, Text, useTheme } from '@waves/ui';

/**
 * One round translucent action on a hero — a white glyph on a dim white disc.
 * Icon-only; its name rides on the accessibility label.
 */
export function HeroActionCircle({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 42,
        height: 42,
        borderRadius: 21,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.18)',
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      <Ionicons name={icon} size={iconSize.lg} color={theme.color.onBrand} />
    </Pressable>
  );
}

/**
 * The hero's primary action: a white pill whose ink is the gradient's darkest
 * stop, so the one solid shape on the panel is unmistakably the thing to press.
 *
 * It takes the stops rather than a colour because that darkest stop is the only
 * value guaranteed to clear contrast against white on whichever wash the panel
 * happens to be wearing — the group hero changes its gradient with the balance.
 */
export function HeroPillButton({
  label,
  icon,
  trailingIcon,
  gradient,
  onPress,
  disabled,
  style,
}: {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  trailingIcon?: keyof typeof Ionicons.glyphMap;
  gradient: readonly string[];
  onPress: () => void;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const ink = gradient[0] ?? theme.color.brand;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.xs,
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
        borderRadius: theme.radius.pill,
        backgroundColor: '#FFFFFF',
        opacity: disabled ? 0.6 : pressed ? 0.85 : 1,
        ...style,
      })}
    >
      {icon ? <Ionicons name={icon} size={iconSize.lg} color={ink} /> : null}
      <Text variant="subheading" style={{ color: ink }} numberOfLines={1}>
        {label}
      </Text>
      {trailingIcon ? <Ionicons name={trailingIcon} size={iconSize.md} color={ink} /> : null}
    </Pressable>
  );
}

/** A small white glyph on the hero's top row — sync, filter, scan, overflow. */
export interface HeroAction {
  readonly icon: keyof typeof Ionicons.glyphMap;
  readonly label: string;
  readonly onPress: () => void;
}

export function ScreenHero({
  gradient,
  icon,
  title,
  subtitle,
  back,
  actions = [],
  children,
}: {
  /** The wash. Defaults to the brand indigo where a screen has no verdict. */
  gradient?: readonly string[];
  /** The identity glyph beside the name — what this screen is about. */
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  /** A line of *state* under the name. A string, or a component that owns it. */
  subtitle?: ReactNode;
  /**
   * Given only where there is somewhere to go back to — never on a tab. Carries
   * its own label because the chevron is the one control here with no word
   * beside it, and a screen reader announcing an untranslated "back" on an
   * Arabic build is the kind of gap nothing else catches.
   */
  back?: { readonly label: string; readonly onPress: () => void };
  actions?: readonly HeroAction[];
  /** The body: a balance, a count, a total, a search field. */
  children?: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const stops = gradient ?? theme.gradient.brand;

  return (
    <Gradient
      radius={0}
      colors={stops}
      style={{
        paddingTop: insets.top + theme.spacing.md,
        paddingHorizontal: theme.spacing.xl,
        paddingBottom: theme.spacing.md,
        borderBottomLeftRadius: theme.radius.xxl,
        borderBottomRightRadius: theme.radius.xxl,
        gap: theme.spacing.lg,
      }}
    >
      <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
        {back ? (
          <Pressable
            onPress={back.onPress}
            accessibilityRole="button"
            accessibilityLabel={back.label}
            hitSlop={10}
          >
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.xxl}
              color={theme.color.onBrand}
            />
          </Pressable>
        ) : null}
        {icon ? <Ionicons name={icon} size={iconSize.xl} color={theme.color.onBrand} /> : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="subheading" tone="onBrand" numberOfLines={1}>
            {title}
          </Text>
          {typeof subtitle === 'string' ? (
            <Text variant="micro" tone="onBrand" style={{ opacity: 0.85 }} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : (
            subtitle
          )}
        </View>
        {actions.map((action) => (
          <Pressable
            key={action.label}
            onPress={action.onPress}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            hitSlop={10}
          >
            <Ionicons name={action.icon} size={iconSize.xl} color={theme.color.onBrand} />
          </Pressable>
        ))}
      </Row>

      {children}
    </Gradient>
  );
}
