/**
 * The dashboard's rotating tips — one useful, Baaki-specific hint at a time.
 *
 * These are not generic money advice; each points at something the app can
 * actually do that a new person would not find on their own (add by voice,
 * reshape a split, nudge a debtor, work offline, scan a receipt). One shows at a
 * time and it rotates by the day, so the surface never becomes a wall of cards —
 * the same restraint the dashboard's single deck keeps. A tip can be dismissed
 * for good with its close; once every tip is dismissed the card stops appearing.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';

import type { UiStrings } from '@/i18n';

export interface Tip {
  /** Stable id — the key a dismissal is remembered under, so the set survives copy edits. */
  id: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
  /** Where tapping the card goes, when the tip has a next step. */
  route?: string;
}

/** The AsyncStorage key holding the ids the person has dismissed for good. */
const DISMISS_KEY = 'dashboardTips:dismissed';
const DAY_MS = 86_400_000;

function buildTips(t: UiStrings): Tip[] {
  return [
    { id: 'voice', icon: 'mic-outline', title: t.tips.voiceTitle, body: t.tips.voiceBody },
    { id: 'split', icon: 'pie-chart-outline', title: t.tips.splitTitle, body: t.tips.splitBody },
    {
      id: 'remind',
      icon: 'notifications-outline',
      title: t.tips.remindTitle,
      body: t.tips.remindBody,
    },
    {
      id: 'offline',
      icon: 'cloud-offline-outline',
      title: t.tips.offlineTitle,
      body: t.tips.offlineBody,
    },
    {
      id: 'scan',
      icon: 'scan-outline',
      title: t.tips.scanTitle,
      body: t.tips.scanBody,
      route: '/capture?scan=1',
    },
  ];
}

/**
 * The tip to show right now, plus a way to retire it. Returns `null` while the
 * dismissed set is still loading (so the card never flashes in then vanishes)
 * and once nothing is left to show. The live tip is picked by the day so it
 * changes daily, and skips anything already dismissed.
 */
export function useDashboardTips(t: UiStrings): { tip: Tip | null; dismiss: () => void } {
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const [ready, setReady] = useState(false);
  // The day index is read once, off the render path — `Date.now()` is impure, so
  // calling it during render would make the picked tip unstable across re-renders.
  const [day, setDay] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(DISMISS_KEY)
      .then((raw) => {
        if (!alive) return;
        try {
          setDismissed(raw ? (JSON.parse(raw) as string[]) : []);
        } catch {
          setDismissed([]);
        }
      })
      .catch(() => {})
      .finally(() => {
        // Stamped here, inside the async callback rather than in the effect body,
        // so `Date.now()` stays off the render path and no synchronous setState
        // fires in the effect itself.
        if (alive) {
          setDay(Math.floor(Date.now() / DAY_MS));
          setReady(true);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const available = useMemo(
    () => buildTips(t).filter((tip) => !dismissed.includes(tip.id)),
    [t, dismissed],
  );

  const tip =
    !ready || day === null || available.length === 0 ? null : available[day % available.length];

  const dismiss = useCallback(() => {
    if (!tip) return;
    setDismissed((prev) => {
      if (prev.includes(tip.id)) return prev;
      const next = [...prev, tip.id];
      void AsyncStorage.setItem(DISMISS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, [tip]);

  return { tip, dismiss };
}
