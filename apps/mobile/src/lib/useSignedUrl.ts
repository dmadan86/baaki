import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * Resolve a private-Storage path to a signed URL, and keep it fresh.
 *
 * Every signed URL the app mints for a private bucket (group photos, avatars,
 * capture receipts) expires after 60 minutes (see `data/api.ts`). Minted once
 * into state, it would go stale in place: a screen left open past the hour, or
 * an app resumed after longer, would show a broken image with nothing to
 * re-mint it. This re-resolves on two triggers that cover both cases — a timer
 * set safely inside the lifetime, and a return to the foreground when the last
 * mint is old enough to be worth spending a request on — so a URL that is
 * actually on screen never rots to a 401.
 *
 * The stale URL is cleared during render on a key change (not in an effect), so
 * the previous path's image never flashes for a frame under a new key.
 */
const LIFETIME_MS = 60 * 60 * 1000;
// Comfortably inside the hour, so the replacement is minted and loaded before
// the one on screen can expire.
const REFRESH_MS = 50 * 60 * 1000;

export function useSignedUrl(
  key: string | null | undefined,
  resolve: (key: string) => Promise<string | null>,
): string | null {
  const path = key ?? null;
  const [resolved, setResolved] = useState<{ key: string | null; url: string | null }>({
    key: null,
    url: null,
  });

  if (resolved.key !== path) setResolved({ key: path, url: null });

  // The three callers pass a module-level resolver (`groupPhotoUrl`,
  // `avatarPhotoUrl`, `capturePhotoUrl`) — stable identities — so `resolve` is
  // an honest dependency here and does not churn the effect.
  useEffect(() => {
    if (!path) return;
    let active = true;
    let lastMintAt = 0;
    // mint() fires from three places — the initial call, the timer and the
    // foreground listener — so several can be in flight at once. A slower older
    // request must not resolve after a newer one and overwrite the fresh URL
    // (or push `lastMintAt` forward), so each mint takes a ticket and only the
    // latest one is allowed to apply its result.
    let latest = 0;

    const mint = (): void => {
      const ticket = (latest += 1);
      void resolve(path)
        .then((url) => {
          if (!active || ticket !== latest) return;
          // Advance the clock only on a real URL, so a failed mint (a null from
          // the resolver, or a rejection) leaves `lastMintAt` where it was —
          // then the next foreground retries at once instead of the broken image
          // sitting for the full refresh window before another attempt.
          if (url) lastMintAt = Date.now();
          setResolved({ key: path, url });
        })
        .catch(() => {
          if (active && ticket === latest) setResolved({ key: path, url: null });
        });
    };

    mint();
    const timer = setInterval(mint, REFRESH_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      // Only spend a request on resume if the URL on screen is old enough to be
      // near or past expiry — a quick app switch should not re-mint everything.
      if (state === 'active' && Date.now() - lastMintAt >= REFRESH_MS) mint();
    });

    return () => {
      active = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [path, resolve]);

  return resolved.key === path ? resolved.url : null;
}

export const SIGNED_URL_LIFETIME_MS = LIFETIME_MS;
