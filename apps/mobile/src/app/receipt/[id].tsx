import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { EmptyState, IconButton, iconSize, Screen, useTheme } from '@waves/ui';

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
  // this screen's life), so the effect only ever has a path to resolve.
  const [state, setState] = useState<'loading' | 'ready' | 'empty'>(path ? 'loading' : 'empty');
  useEffect(() => {
    if (!path) return;
    let active = true;
    void (async () => {
      const resolved = await imageUrl('receipts', path);
      if (!active) return;
      if (resolved) {
        setUri(resolved);
        setState('ready');
      } else {
        setState('empty');
      }
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
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState title={t.loadError} body={t.loadErrorBody} />
          </View>
        )}
      </View>
    </Screen>
  );
}
