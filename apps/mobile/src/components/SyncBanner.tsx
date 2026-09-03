/**
 * What the app is doing about the network, said plainly.
 *
 * ADR-005 makes offline a normal state rather than an error, so this is not an
 * alarm. It appears only when there is something the user might otherwise
 * wonder about — unsent changes, or a change the server refused — and says what
 * is true: the entry is saved, it just hasn't left the phone yet.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Animated, Easing, Pressable, View } from 'react-native';

import { deadLettered } from '@waves/core';
import { Card, iconSize, Row, Text, useTheme } from '@waves/ui';

import { plural, useStrings } from '@/i18n';

import { isPhoneCountryError } from '@/lib/phone';
import { useReducedMotion } from '@/lib/reducedMotion';
import { SyncNetworkPreference, useSyncNetwork } from '@/lib/syncNetwork';
import { SyncStatus, useSync } from '@/sync';

/**
 * The sync state as a single header glyph, next to the camera on the dashboard.
 *
 * The full banner (below) is right on a screen that is about one group's ledger;
 * on the dashboard it was a wide card carrying a sentence for a state that is
 * normal and usually momentary. This says the same thing in the corner: a
 * refused change is a red alert that needs a look, an unsent queue or a dropped
 * connection is a quiet cloud, an in-flight sync is a turning arrow. When there
 * is nothing to report — online, idle, nothing queued — it renders nothing, so
 * the header is not carrying a permanent "all good" badge nobody asked for.
 */
export function SyncStatusIcon({
  onBrand = false,
  groupId,
}: { onBrand?: boolean; groupId?: string } = {}) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const { t, locale } = useStrings();
  const { status, queue, rejected } = useSync();

  // On a group screen, scope the queued/refused counts to this group — the same
  // predicate the inline SyncBanner uses — so the header glyph reflects THIS
  // group's state, not another group's refused change. Omitted (the dashboard)
  // keeps the whole-account view. Connection status (offline/syncing) stays
  // global, since the network is not per-group.
  const refused = groupId ? rejected.filter((item) => item.groupId === groupId) : rejected;
  const pending = groupId ? queue.filter((item) => item.groupId === groupId) : queue;
  // A mutation that has exhausted its retries is not "syncing" — it has stopped,
  // and it blocks everything queued behind it in its group. Under the old
  // glyph it still counted as pending, so the header said "sending 1 change…"
  // forever while nothing was being sent. It needs the same decision a refusal
  // does, so it gets the same red.
  const stuck = deadLettered(pending);
  const stopped = refused.length + stuck.length;

  const spin = useState(() => new Animated.Value(0))[0];
  const spinning = status === SyncStatus.Syncing && !reduceMotion;
  useEffect(() => {
    if (!spinning) return;
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
      spin.setValue(0);
    };
  }, [spinning, spin]);

  // One neutral colour for every ordinary sync state — offline, waiting, in
  // flight — so the glyph reads as one header control, the same weight as the
  // camera beside it, not a different-coloured badge each time the network
  // shifts. Red is reserved for the one state that needs a decision: a change
  // the server refused (ADR-005 treats plain offline as normal, not an error).
  // On the green hero the glyph rides white ink (onBrand); everywhere else the
  // neutral header ink. Red still wins for a refused change — it needs to read
  // as an alert whatever it sits on.
  const neutral = onBrand ? theme.color.onBrand : theme.color.text;
  const state =
    stopped > 0
      ? {
          icon: 'alert-circle' as const,
          color: theme.color.negative,
          label:
            refused.length > 0
              ? t.extras.oneChangeFailed
              : plural(locale, stuck.length, t.sync.stuckCount),
        }
      : status === SyncStatus.Offline
        ? { icon: 'cloud-offline-outline' as const, color: neutral, label: t.misc.offlineSaved }
        : status === SyncStatus.Error
          ? {
              icon: 'cloud-offline-outline' as const,
              color: neutral,
              label: t.misc.cantReachServerIdle,
            }
          : status === SyncStatus.Metered
            ? { icon: 'cloud-offline-outline' as const, color: neutral, label: t.sync.waitingWifi }
            : status === SyncStatus.Syncing || pending.length > 0
              ? {
                  icon: 'sync-outline' as const,
                  color: neutral,
                  label: plural(locale, pending.length, t.misc.syncingCount),
                }
              : null;

  // Online, idle, nothing queued — say nothing.
  if (!state) return null;

  const glyph = <Ionicons name={state.icon} size={iconSize.xl} color={state.color} />;

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={state.label}
      style={{ padding: theme.spacing.xs }}
    >
      {spinning ? (
        <Animated.View
          style={{
            transform: [
              { rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
            ],
          }}
        >
          {glyph}
        </Animated.View>
      ) : (
        glyph
      )}
    </View>
  );
}

export function SyncBanner({ groupId }: { groupId?: string }) {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { status, queue, rejected, retry, discard } = useSync();
  const { preference: syncNetwork } = useSyncNetwork();

  const pending = groupId ? queue.filter((item) => item.groupId === groupId) : queue;
  const refused = groupId ? rejected.filter((item) => item.groupId === groupId) : rejected;
  const stuck = deadLettered(pending);

  if (refused.length > 0) {
    const first = refused[0];
    return (
      <Card style={{ backgroundColor: theme.color.negativeSoft, gap: theme.spacing.md }}>
        <Row style={{ gap: theme.spacing.sm }}>
          <Ionicons name="alert-circle" size={iconSize.md} color={theme.color.negative} />
          <Text variant="subheading" tone="negative">
            {t.extras.oneChangeFailed}
          </Text>
        </Row>
        {/* Never the raw server string. `first.message` arrives as an internal
            code like "PHONE_NEEDS_COUNTRY_CODE: 9535621101 has no country code";
            a bare uncoded number gets the one friendly, localized sentence that
            actually helps, and anything else the neutral "refused" line. The raw
            reason still travels to Sentry via the sync engine. */}
        <Text variant="caption" tone="muted">
          {first && isPhoneCountryError(first)
            ? t.people.phoneNeedsCountryCode
            : t.misc.serverRefused}
        </Text>
        {/* The two recovery actions for a refused change — the buttons a person
            most needs to hit. A caption Text alone left the tap area ~18pt tall;
            a 44pt floor plus hitSlop makes each a real target, and an explicit
            label names the action for a screen reader rather than leaning on the
            child text. */}
        <Row style={{ gap: theme.spacing.lg }}>
          <Pressable
            onPress={() => first && void retry(first.clientMutationId)}
            accessibilityRole="button"
            accessibilityLabel={t.extras.tryAgain}
            hitSlop={8}
            style={({ pressed }) => ({
              minHeight: 44,
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text variant="caption" tone="brand">
              {t.extras.tryAgain}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => first && void discard(first.clientMutationId)}
            accessibilityRole="button"
            accessibilityLabel={t.extras.discardIt}
            hitSlop={8}
            style={({ pressed }) => ({
              minHeight: 44,
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text variant="caption" tone="muted">
              {t.extras.discardIt}
            </Text>
          </Pressable>
        </Row>
      </Card>
    );
  }

  // Nothing refused, but something has stopped trying.
  //
  // `MAX_ATTEMPTS` backoffs is roughly eight and a half minutes of a transport
  // that will not take this mutation — a payload an older server rejects at the
  // edge, a body too large, a bug. `nextBatch` then skips the whole group, so
  // everything entered after it in that group waits behind it with nothing on
  // screen to say why. `deadLettered` has existed since the queue was written
  // and was called from nowhere; this is the surface it was waiting for.
  if (stuck.length > 0) {
    // The head of the queue is what blocks the group — order is preserved
    // within a group, so retrying or dropping the oldest is what actually gets
    // the rest moving. `deadLettered` preserves queue order, so this is it.
    const head = stuck[0];
    return (
      <Card style={{ backgroundColor: theme.color.negativeSoft, gap: theme.spacing.md }}>
        <Row style={{ gap: theme.spacing.sm }}>
          <Ionicons name="alert-circle" size={iconSize.md} color={theme.color.negative} />
          <Text variant="subheading" tone="negative">
            {plural(locale, stuck.length, t.sync.stuckCount)}
          </Text>
        </Row>
        <Text variant="caption" tone="muted">
          {t.sync.stuckExplain}
        </Text>
        <Row style={{ gap: theme.spacing.lg }}>
          <Pressable
            onPress={() => head && void retry(head.clientMutationId)}
            accessibilityRole="button"
            accessibilityLabel={t.extras.tryAgain}
            hitSlop={8}
            style={({ pressed }) => ({
              minHeight: 44,
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text variant="caption" tone="brand">
              {t.extras.tryAgain}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => head && void discard(head.clientMutationId)}
            accessibilityRole="button"
            accessibilityLabel={t.extras.discardIt}
            hitSlop={8}
            style={({ pressed }) => ({
              minHeight: 44,
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text variant="caption" tone="muted">
              {t.extras.discardIt}
            </Text>
          </Pressable>
        </Row>
      </Card>
    );
  }

  if (pending.length === 0 && status !== 'offline' && status !== 'error') return null;

  // Held back by the network preference: online, but not over a connection the
  // user allows sync on. Say which network it is waiting for, not "offline" —
  // the phone is not offline, it is being polite about data.
  if (status === 'metered') {
    return (
      <Card style={{ backgroundColor: theme.color.buttonPrimary, gap: theme.spacing.xs }}>
        <Row style={{ gap: theme.spacing.sm }}>
          <Ionicons name="cloud-offline-outline" size={iconSize.md} color={theme.color.onBrand} />
          <View style={{ flex: 1 }}>
            <Text variant="caption" tone="onBrand">
              {syncNetwork === SyncNetworkPreference.Cellular
                ? t.sync.waitingCellular
                : t.sync.waitingWifi}
            </Text>
          </View>
        </Row>
      </Card>
    );
  }

  // Three different truths, and saying the wrong one is worse than saying
  // nothing: "syncing…" while every request is failing reads as a hang, and
  // eventually as lost data.
  //
  // The count is pluralised rather than glued together from a number and a
  // word. These four sentences were the last English left in the app after the
  // i18n sweep, and "3 changes" cannot be built by suffixing anything in Tamil,
  // Hindi or Arabic.
  const { icon, message } =
    status === 'offline'
      ? {
          icon: 'cloud-offline-outline' as const,
          message:
            pending.length > 0
              ? plural(locale, pending.length, t.misc.offlineWithCount)
              : t.misc.offlineSaved,
        }
      : status === 'error'
        ? {
            icon: 'cloud-offline-outline' as const,
            // With nothing queued there is no count to quote — a bare "0 changes
            // saved here, waiting to send" is both wrong (nothing is waiting) and
            // alarming on a phone that is plainly online.
            message:
              pending.length > 0
                ? plural(locale, pending.length, t.misc.cantReachServer)
                : t.misc.cantReachServerIdle,
          }
        : {
            icon: 'sync-outline' as const,
            message: plural(locale, pending.length, t.misc.syncingCount),
          };

  return (
    <Card style={{ backgroundColor: theme.color.buttonPrimary, gap: theme.spacing.xs }}>
      <Row style={{ gap: theme.spacing.sm }}>
        <Ionicons name={icon} size={iconSize.md} color={theme.color.onBrand} />
        <View style={{ flex: 1 }}>
          <Text variant="caption" tone="onBrand">
            {message}
          </Text>
        </View>
      </Row>
      {/* The raw exception used to print here under the friendly line — things
          like "NativeStatement.finalizeAsync ... database is locked". It is an
          internal message, never translated and never actionable, and it made a
          normal offline state read as a broken app. It still travels to Sentry
          via reportHandled; it just no longer lands on the screen. The friendly
          line above already says the one thing the user needs: saved here,
          waiting to send. */}
    </Card>
  );
}
