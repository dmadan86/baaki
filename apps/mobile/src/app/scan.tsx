import { lazy, Suspense } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { EmptyState, IconButton, iconSize, Row, Screen, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { cameraAvailable } from '@/lib/qrScan';

// Only pulled in when the native camera is present — a dynamic import so an
// older binary never even evaluates `expo-camera`.
const ScannerCamera = lazy(() => import('@/components/ScannerCamera'));

/**
 * Point the camera at a group's invite QR and land in the join flow.
 *
 * The scanned code carries the same invite token an invite link does, so a good
 * read just hands off to `/join?token=…` — the one screen that already previews
 * the group and runs the ghost-claim. When the running binary predates
 * `expo-camera` (a JS-only reload of an old dev-client), the screen says so
 * instead of reaching for a camera that is not in the build yet.
 */
export default function ScanScreen() {
  const theme = useTheme();
  const { t } = useStrings();
  const available = cameraAvailable();

  const onToken = (token: string): void => {
    router.replace(`/join?token=${encodeURIComponent(token)}`);
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
        <IconButton label={t.common.close} onPress={() => router.back()}>
          <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
        </IconButton>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="heading">{t.misc.scanToJoin}</Text>
        </View>
        <View style={{ width: 44 }} />
      </Row>

      {available ? (
        <Suspense
          fallback={
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color={theme.color.brand} />
            </View>
          }
        >
          <ScannerCamera onToken={onToken} />
        </Suspense>
      ) : (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <EmptyState
            icon={<Ionicons name="qr-code-outline" size={iconSize.xxl} color={theme.color.brand} />}
            title={t.misc.scanToJoin}
            body={t.misc.scanRebuild}
          />
        </View>
      )}
    </Screen>
  );
}
