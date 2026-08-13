import { useCallback, useState } from 'react';

import { useSync } from '@/sync';

/**
 * Pull-to-refresh that only spins when the user actually pulled.
 *
 * The lists read local-first (ADR-005), so a background offline→cloud sync is
 * not a refresh and must not spin the control on its own — bound to the sync
 * status, the native spinner appeared unbidden on every flush and read as a
 * reload nobody asked for. Here the spinner is tied to the gesture: it shows
 * from the pull until the flush it kicked off settles, and background sync
 * never touches it. The SyncBanner already says when work is in flight.
 */
export function usePullRefresh(): { refreshing: boolean; onRefresh: () => void } {
  const { flush } = useSync();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void Promise.resolve(flush()).finally(() => setRefreshing(false));
  }, [flush]);

  return { refreshing, onRefresh };
}
