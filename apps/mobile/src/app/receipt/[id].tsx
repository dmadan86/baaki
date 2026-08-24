import { useCallback, useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { Button, EmptyState, IconButton, iconSize, Screen, useTheme } from '@waves/ui';

import { ZoomableImage } from '@/components/ZoomableImage';
import { useStrings } from '@/i18n';
import { imageUrl } from '@/lib/storage';

/**
 * See the bill, any time after it was kept (E2).
 *
 * The receipt lives in R2 under the group + expense id, and is group-readable —
 * the `r2-sign` edge authorises a read by group membership — so any member can
 * open it, not just whoever kept it. The storage path is handed in as a route
 * param; this screen resolves it to a signed URL and shows it full-bleed, pinch
 * to zoom. A path that resolves to nothing — a bill that was never kept, or has
 * since been removed — is a calm empty state, never a crash.
 */
export default function ReceiptViewerScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  // `id` is the expense id in the route; the receipt itself is addressed by the
  // `path` param, which is what actually resolves the image.
  const { path } = useLocalSearchParams<{ id?: string; path?: string }>();

  const [uri, setUri] = useState<string | null>(null);
  // No path is "empty" from the first frame (the route param never changes over
  // this screen's life), so the resolve only ever has a path to work with.
  const [state, setState] = useState<'loading' | 'ready' | 'empty'>(path ? 'loading' : 'empty');

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

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
        <View style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.close} onPress={() => router.back()}>
            <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
          </IconButton>
        </View>

        {state === 'ready' && uri ? (
          <ZoomableImage uri={uri} />
        ) : state === 'loading' ? (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <ActivityIndicator color={theme.color.brand} />
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
      </View>
    </Screen>
  );
}
