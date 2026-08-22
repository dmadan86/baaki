/**
 * The live camera that reads an invite QR — the leaf that actually touches
 * `expo-camera`.
 *
 * It is only ever loaded (via a dynamic import) once `cameraAvailable()` is
 * true, so importing `expo-camera` here cannot crash an older binary: the
 * module is never evaluated on a build that lacks the native side. It owns the
 * permission dance because that is an `expo-camera` hook; the surrounding
 * chrome (close, title) belongs to the route.
 */

import { useRef, useState } from 'react';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';

import { Button, Callout, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { tokenFromScan } from '@/lib/qrScan';

export default function ScannerCamera({ onToken }: { onToken: (token: string) => void }) {
  const theme = useTheme();
  const { t } = useStrings();
  const [permission, requestPermission] = useCameraPermissions();
  // A read fires many frames a second; once we have a good token we hand it up
  // once and stop, and a bad read only flags itself without locking the camera.
  const handled = useRef(false);
  const [invalid, setInvalid] = useState(false);

  if (!permission) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.color.brand} />
      </View>
    );
  }

  if (!permission.granted) {
    const canAsk = permission.canAskAgain;
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.spacing.lg,
          padding: theme.spacing.xl,
        }}
      >
        <Text variant="body" tone="muted" align="center">
          {canAsk ? t.misc.scanAllowBody : t.misc.scanDenied}
        </Text>
        <Button
          label={t.misc.scanAllow}
          size="lg"
          onPress={() => void (canAsk ? requestPermission() : Linking.openSettings())}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (handled.current) return;
          const token = tokenFromScan(data);
          if (!token) {
            setInvalid(true);
            return;
          }
          handled.current = true;
          onToken(token);
        }}
      />

      {/* The aiming frame and the one line that says what to point at, floated
          over the feed. */}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}
      >
        <View
          style={{
            width: 232,
            height: 232,
            borderRadius: theme.radius.xl,
            borderWidth: 3,
            borderColor: '#FFFFFF',
          }}
        />
      </View>

      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: theme.spacing.xl,
          right: theme.spacing.xl,
          bottom: theme.spacing.xxxl,
          gap: theme.spacing.md,
          alignItems: 'center',
        }}
      >
        {invalid ? <Callout tone="negative">{t.misc.scanInvalid}</Callout> : null}
        <Text variant="body" style={{ color: '#FFFFFF' }} align="center">
          {t.misc.scanHint}
        </Text>
      </View>
    </View>
  );
}
