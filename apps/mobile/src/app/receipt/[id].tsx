import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StatusBar, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, EmptyState, Row, useTheme } from '@waves/ui';

import { ViewerButton } from '@/components/ViewerButton';
import { ZoomableImage } from '@/components/ZoomableImage';
import { useStrings } from '@/i18n';
import { imageUrl } from '@/lib/storage';
import { saveImageToDevice } from '@/lib/saveImage';

/**
 * See the bill, any time after it was kept (E2).
 *
 * The receipt lives in R2 under the group + expense id, and is group-readable —
 * the `r2-sign` edge authorises a read by group membership — so any member can
 * open it, not just whoever kept it. The storage path is handed in as a route
 * param; this screen resolves it to a signed URL and shows it full-bleed on a
 * dark, immersive backdrop (the Photos/ChatGPT viewer pattern), pinch- and
 * double-tap-to-zoom, with the close and save controls floating over the image
 * rather than in a bar. A path that resolves to nothing — a bill that was never
 * kept, or has since been removed — is a calm empty state, never a crash.
 */
export default function ReceiptViewerScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useStrings();
  // `id` is the expense id in the route; the receipt itself is addressed by the
  // `path` param, which is what actually resolves the image.
  const { path } = useLocalSearchParams<{ id?: string; path?: string }>();

  const [uri, setUri] = useState<string | null>(null);
  // No path is "empty" from the first frame (the route param never changes over
  // this screen's life), so the resolve only ever has a path to work with.
  const [state, setState] = useState<'loading' | 'ready' | 'empty'>(path ? 'loading' : 'empty');
  const [saving, setSaving] = useState(false);

  // Resolve the path to a signed URL. Extracted so the empty state's retry can
  // run it again — a resolve can fail transiently (offline, a signing hiccup),
  // and a bill that is really there should not be one blank screen away.
  const load = useCallback(async () => {
    if (!path) {
      setState('empty');
      return;
    }
    setState('loading');
    const resolved = await imageUrl('receipts', path);
    if (resolved) {
      setUri(resolved);
      setState('ready');
    } else {
      setState('empty');
    }
  }, [path]);

  // The mount resolve does not go through `load` (which flips to 'loading'
  // first): setting state synchronously inside an effect cascades renders, and
  // the screen already starts in 'loading'. `load` is the retry path.
  useEffect(() => {
    let active = true;
    void (async () => {
      if (!path) return;
      const resolved = await imageUrl('receipts', path);
      if (!active) return;
      setUri(resolved);
      setState(resolved ? 'ready' : 'empty');
    })();
    return () => {
      active = false;
    };
  }, [path]);

  const onSave = useCallback(async () => {
    if (!uri || saving) return;
    setSaving(true);
    const result = await saveImageToDevice(uri);
    setSaving(false);
    if (result === 'error') Alert.alert(t.receipts.couldNotSave);
  }, [uri, saving, t]);

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <StatusBar barStyle="light-content" />

      {state === 'ready' && uri ? (
        <ZoomableImage uri={uri} />
      ) : state === 'loading' ? (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <ActivityIndicator color="#FFFFFF" />
        </View>
      ) : (
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: theme.spacing.xl,
            gap: theme.spacing.lg,
          }}
        >
          <EmptyState title={t.loadError} body={t.loadErrorBody} />
          <Button label={t.retry} onPress={() => void load()} />
        </View>
      )}

      {/* Controls float over the image so nothing squeezes the pixels. */}
      <Row
        style={{
          position: 'absolute',
          top: insets.top + theme.spacing.sm,
          left: theme.spacing.xl,
          right: theme.spacing.xl,
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <ViewerButton icon="close" label={t.common.close} onPress={() => router.back()} />
        {state === 'ready' && uri ? (
          <ViewerButton
            icon="download-outline"
            label={t.receipts.download}
            onPress={() => void onSave()}
            busy={saving}
          />
        ) : null}
      </Row>
    </View>
  );
}
