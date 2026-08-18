/**
 * The wall and the nudge.
 *
 * `UpdateGate` replaces the whole app when the installed build is no longer
 * allowed to run. It says what is happening, gives the one button that fixes
 * it, and — because a wall with no way past it is worse than no wall — a way
 * to ask again, for the case where the policy itself was the mistake.
 *
 * `UpdateBanner` is the other half: a newer build exists, nothing is wrong, so
 * it sits above the content and can be waved away.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, iconSize, Row, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';

import { useUpdate } from '@/lib/update';

export function UpdateGate({ children }: { children: React.ReactNode }) {
  const { decision } = useUpdate();
  if (decision !== 'required') return <>{children}</>;
  return <BlockingScreen />;
}

function BlockingScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  const { message, installed, latest, openStore, recheck } = useUpdate();

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.xl,
        backgroundColor: theme.color.bg,
        padding: theme.spacing.xxxl,
      }}
    >
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: theme.radius.pill,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.color.brandSoft,
        }}
      >
        <Ionicons name="arrow-up-circle" size={iconSize.huge} color={theme.color.brand} />
      </View>

      <Text variant="heading" align="center">
        {t.extras.needsUpdating}
      </Text>

      <Text variant="caption" tone="muted" align="center">
        {message ?? t.misc.versionStoppedBody}
      </Text>

      {/* Said plainly, because "will I lose my data" is the actual worry and
          nobody is going to install anything until it is answered. */}
      <Text variant="caption" tone="muted" align="center">
        {t.extras.nothingIsLost}
      </Text>

      <View style={{ alignSelf: 'stretch', gap: theme.spacing.sm }}>
        <Button label={t.misc.updateBaaki} size="lg" fullWidth onPress={openStore} />
        <Button
          label={t.misc.alreadyUpdated}
          variant="ghost"
          fullWidth
          onPress={() => void recheck()}
        />
      </View>

      <Text variant="micro" tone="muted" align="center">
        {t.misc.youHaveVersion.replace('{installed}', installed)}
        {latest ? t.misc.versionAvailable.replace('{latest}', latest) : ''}
      </Text>
    </View>
  );
}

/**
 * Sits over the top of whatever screen is showing. Absolute rather than in the
 * layout so that adding it never moves anything: a banner that reflows every
 * screen underneath it is a banner that gets dismissed for the wrong reason.
 */
export function UpdateBanner(): React.JSX.Element | null {
  const theme = useTheme();
  const { t } = useStrings();
  const insets = useSafeAreaInsets();
  const { decision, dismissed, dismiss, openStore, latest } = useUpdate();

  if (decision !== 'suggested' || dismissed) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: insets.top + theme.spacing.sm,
        left: theme.spacing.xl,
        right: theme.spacing.xl,
        zIndex: 10,
      }}
    >
      <Card style={{ gap: theme.spacing.sm, ...theme.shadow.lifted }}>
        <Row style={{ gap: theme.spacing.md }}>
          <Ionicons name="arrow-up-circle-outline" size={iconSize.xl} color={theme.color.brand} />
          <View style={{ flex: 1 }}>
            <Text variant="caption">
              {latest ? t.misc.baakiVersionOut.replace('{latest}', latest) : t.misc.newBaakiOut}
            </Text>
            <Text variant="micro" tone="muted">
              {t.extras.worthAMinute}
            </Text>
          </View>
        </Row>
        <Row style={{ gap: theme.spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Button label={t.misc.update} size="sm" fullWidth onPress={openStore} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label={t.misc.notNow} size="sm" variant="ghost" fullWidth onPress={dismiss} />
          </View>
        </Row>
      </Card>
    </View>
  );
}
