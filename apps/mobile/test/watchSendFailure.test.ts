/**
 * What happens to a phone→watch payload that never arrives.
 *
 * Delivery is asynchronous on both platforms, so `sendToWatch` returning true
 * only means the payload left the phone. iOS hands a queued transfer to
 * WatchConnectivity and hears the outcome much later through
 * `didFinishUserInfoTransfer` (surfaced as an `onWatchSendFailed` event);
 * Android rejects the send promise. Before this, neither reached JS: the iOS
 * delegate method did not exist — WatchConnectivity logged that the delegate
 * "does not implement session:didFinishUserInfoTransfer:error:" — and the
 * Android rejection was swallowed whole to stop it becoming an unhandled
 * rejection.
 *
 * That silence had a cost beyond the lost message. The recent-list relay skips
 * a list identical to the one it last sent, and a send that failed after
 * leaving still counted as sent, so the watch could sit on a stale list until
 * the list itself changed. These cover both transports reporting the loss, and
 * the bridge's rule for acting on it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Set before each dynamic import; the module reads it once at load. */
const stub = vi.hoisted(() => ({ native: null as Record<string, unknown> | null }));

vi.mock('expo', () => ({
  requireOptionalNativeModule: () => stub.native,
}));

type EventHandler = (event: { t?: unknown }) => void;

/**
 * A fake native module. `sendResult` is what `sendToWatch` hands back — a
 * rejected promise stands in for Android's failed node lookup; `undefined` for
 * iOS, whose send is synchronous and reports later through the event instead.
 */
function nativeStub(opts: { sendResult?: () => unknown; noEvent?: boolean } = {}) {
  const listeners: Record<string, EventHandler[]> = {};
  let removed = 0;
  return {
    module: {
      isReachable: () => true,
      sendToWatch: () => (opts.sendResult ? opts.sendResult() : undefined),
      addListener: (event: string, handler: EventHandler) => {
        if (opts.noEvent && event === 'onWatchSendFailed') {
          throw new Error('unknown event');
        }
        (listeners[event] ??= []).push(handler);
        return {
          remove() {
            removed += 1;
          },
        };
      },
    },
    /** Fire what iOS's delegate would send up. */
    emit(event: string, payload: { t?: unknown }) {
      for (const handler of listeners[event] ?? []) handler(payload);
    },
    get removeCount() {
      return removed;
    },
  };
}

async function loadModule(native: Record<string, unknown> | null) {
  stub.native = native;
  vi.resetModules();
  return import('@/lib/watch/nativeModule');
}

/** Let the swallowed rejection's `.catch` run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const RECENT = { t: 'recent' as const, items: [] };

beforeEach(() => {
  stub.native = null;
});

describe('watch send failures reach JS', () => {
  it('reports the message kind when the native send rejects (Android)', async () => {
    const fake = nativeStub({ sendResult: () => Promise.reject(new Error('no nodes')) });
    const { onWatchSendFailed, sendToWatch } = await loadModule(fake.module);

    const seen: (string | null)[] = [];
    onWatchSendFailed((kind) => seen.push(kind));

    // True: the payload did leave this side. The loss is only known later.
    expect(sendToWatch(RECENT)).toBe(true);
    expect(seen).toEqual([]);

    await flush();
    expect(seen).toEqual(['recent']);
  });

  it('reports the kind named by the iOS transfer event', async () => {
    const fake = nativeStub();
    const { onWatchSendFailed } = await loadModule(fake.module);

    const seen: (string | null)[] = [];
    onWatchSendFailed((kind) => seen.push(kind));

    fake.emit('onWatchSendFailed', { t: 'ack' });
    expect(seen).toEqual(['ack']);
  });

  it('reports null when the transfer does not name a kind', async () => {
    const fake = nativeStub();
    const { onWatchSendFailed } = await loadModule(fake.module);

    const seen: (string | null)[] = [];
    onWatchSendFailed((kind) => seen.push(kind));

    // The Swift side sends "" for a payload with no readable `t`.
    fake.emit('onWatchSendFailed', { t: '' });
    fake.emit('onWatchSendFailed', {});
    expect(seen).toEqual([null, null]);
  });

  it('stops calling a handler once it unsubscribes', async () => {
    const fake = nativeStub();
    const { onWatchSendFailed } = await loadModule(fake.module);

    const seen: (string | null)[] = [];
    const unsubscribe = onWatchSendFailed((kind) => seen.push(kind));

    fake.emit('onWatchSendFailed', { t: 'recent' });
    unsubscribe();
    fake.emit('onWatchSendFailed', { t: 'recent' });

    expect(seen).toEqual(['recent']);
  });

  it('tells every subscriber even when one of them throws', async () => {
    const fake = nativeStub();
    const { onWatchSendFailed } = await loadModule(fake.module);

    const seen: string[] = [];
    onWatchSendFailed(() => {
      throw new Error('subscriber blew up');
    });
    onWatchSendFailed(() => seen.push('second'));

    expect(() => fake.emit('onWatchSendFailed', { t: 'recent' })).not.toThrow();
    expect(seen).toEqual(['second']);
  });

  it('stays a no-op in a build with no watch module', async () => {
    const { onWatchSendFailed, sendToWatch, watchAvailable } = await loadModule(null);

    expect(watchAvailable()).toBe(false);
    const seen: unknown[] = [];
    const unsubscribe = onWatchSendFailed((kind) => seen.push(kind));

    expect(sendToWatch(RECENT)).toBe(false);
    await flush();
    expect(seen).toEqual([]);
    expect(() => unsubscribe()).not.toThrow();
  });

  it('still reports rejections when the native half predates the event', async () => {
    // An older build: `addListener('onWatchSendFailed')` throws, so only the
    // send-promise path is left. Subscribing must not take the module down.
    const fake = nativeStub({
      noEvent: true,
      sendResult: () => Promise.reject(new Error('no nodes')),
    });
    const { onWatchSendFailed, sendToWatch } = await loadModule(fake.module);

    const seen: (string | null)[] = [];
    expect(() => onWatchSendFailed((kind) => seen.push(kind))).not.toThrow();

    sendToWatch({ t: 'ack', ok: true });
    await flush();
    expect(seen).toEqual(['ack']);
  });
});

describe("the bridge's rule for a lost relay", () => {
  /**
   * `relayRecent`'s dedupe, reduced to the decision under test: a lost `recent`
   * must clear the remembered payload so the identical list is sent again.
   */
  function dedupe() {
    let lastSent: string | null = null;
    return {
      relay(items: string): 'sent' | 'skipped' {
        if (items === lastSent) return 'skipped';
        lastSent = items;
        return 'sent';
      },
      onFailure(kind: string | null) {
        if (kind === null || kind === 'recent') lastSent = null;
      },
      get remembered() {
        return lastSent;
      },
    };
  }

  it('re-sends an unchanged list after that list was lost in transit', () => {
    const d = dedupe();
    expect(d.relay('[A]')).toBe('sent');
    expect(d.relay('[A]')).toBe('skipped');

    d.onFailure('recent');
    expect(d.relay('[A]')).toBe('sent');
  });

  it('clears on an unnamed loss, since it may have been the list', () => {
    const d = dedupe();
    d.relay('[A]');
    d.onFailure(null);
    expect(d.remembered).toBeNull();
  });

  it('keeps the cache when some other message was the one lost', () => {
    const d = dedupe();
    d.relay('[A]');
    d.onFailure('ack');
    // An ack is not worth re-sending the whole list for.
    expect(d.relay('[A]')).toBe('skipped');
  });
});
