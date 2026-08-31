/**
 * Who is holding the one microphone, and when the next capture may open it.
 *
 * Both platforms give the app a *single* recogniser object with a *single*
 * global event stream — `ExpoSpeechRecognitionModule.start/stop/abort` and the
 * `result`/`error`/`end` events are the same recogniser no matter which screen
 * asked. Every surface that dictates (the note mic on an expense, the quick-add
 * panel on the voice screen) therefore hears every other surface's events, and
 * a second `start()` issued before the previous session has finished tearing
 * down does not queue — it lands on top of it.
 *
 * That is the whole family of "the mic worked once and then went dead":
 *
 *  - **A stale `end` closes the new session.** `abort()` does not end the
 *    session there and then; it queues a teardown (Android posts it to the main
 *    looper, iOS runs it in a `Task`) and the `end` arrives some milliseconds
 *    later. By then the panel that aborted has usually been replaced by a fresh
 *    one, which — hearing an `end` it never asked for — decides its own capture
 *    is over before it has begun.
 *  - **The teardown eats the new recogniser.** That queued teardown calls
 *    `cancel()`/`destroy()` on whatever the recogniser field happens to hold
 *    when it finally runs. Start a new session first and it destroys *that* one,
 *    silently: no result, no error, no `end`, a mic stuck on "listening".
 *  - **Two starts at once.** Opening the mic is not instant on our side either
 *    — there is a permission call and an installed-model probe to await first —
 *    so two taps (or a tap racing the auto-start) can both get past a
 *    `listening` check and issue two native starts, with the same outcome.
 *
 * So one object owns the recogniser at a time, and the next owner waits for the
 * previous one's `end` before opening it. Kept free of React and of the native
 * module so the sequencing can be tested without a device — the microphone
 * itself is injected as a two-call driver.
 */

/**
 * How long to wait for the `end` a torn-down session still owes us before
 * assuming it will never come.
 *
 * A guard, not a schedule: `end` normally lands within a frame or two of the
 * teardown. But it is emitted by the native side, and if the app navigates away
 * while a capture is open there may be no component mounted to hand it to us at
 * all. Without the timer the mic would be locked shut for the rest of the
 * session — a far worse failure than the race it is protecting against.
 */
const SETTLE_MS = 1500;

/**
 * The phase of the one recogniser.
 *
 * `held` is the gap our own code opens: the owner has the mic but has not
 * issued the native start yet (it is still awaiting permission and the
 * on-device probe). Nothing is running natively, so giving the mic up from
 * `held` needs no teardown and no wait.
 */
export type SpeechMicPhase = 'idle' | 'held' | 'open' | 'stopping' | 'closing';

/** The two calls this needs from the native recogniser. */
export interface SpeechMicDriver {
  /** Finish the utterance and deliver a last result. */
  stop: () => void;
  /** Drop the session; no final result. */
  abort: () => void;
}

export class SpeechMic {
  private driver: SpeechMicDriver | null = null;
  private owner: symbol | null = null;
  private phase: SpeechMicPhase = 'idle';
  private waiting: (() => void)[] = [];
  private guard: ReturnType<typeof setTimeout> | null = null;
  /**
   * When the `end` an aborted session still owes stops being believable —
   * epoch milliseconds, or 0 when nothing is owed. See {@link release}.
   */
  private owed = 0;

  constructor(private readonly settleMs: number = SETTLE_MS) {}

  /**
   * Point this at the real recogniser.
   *
   * Called at module load by each surface that owns a mic, because those files
   * are the only ones allowed to touch `expo-speech-recognition` (its import
   * throws on binaries built before the native module existed, so it is reached
   * through a guarded `require`). Every caller attaches the same two calls, so
   * attaching twice is harmless.
   */
  attach(driver: SpeechMicDriver): void {
    this.driver = driver;
  }

  /** What the recogniser is doing — for tests and for reasoning, not for UI. */
  get state(): SpeechMicPhase {
    return this.phase;
  }

  /** Whether `token` is the session the recogniser's events belong to. */
  owns(token: symbol): boolean {
    return this.owner === token;
  }

  /**
   * Take the mic for `token`, waiting out a previous session's teardown.
   *
   * Resolves `false` when somebody else is mid-capture — the caller should do
   * nothing rather than abort them, because an abort would race that session's
   * next event and wedge the recogniser for both. Resolves `true` with the mic
   * held, which the caller **must** eventually give back through
   * {@link release}, on every path including the ones that never open it (a
   * refused permission, an unmount while the permission sheet is up). A `held`
   * mic nobody releases is a mic nobody can use again.
   */
  async acquire(token: symbol): Promise<boolean> {
    if (this.owner !== null) return false;
    // A session that has been aborted still owes us an `end`; opening the next
    // one before it lands is exactly what lets the old teardown destroy the new
    // recogniser. Wait it out (or wait out the guard timer).
    if (this.phase === 'closing') await this.settled();
    // Somebody else may have taken it while we waited.
    if (this.owner !== null) return false;
    this.owner = token;
    this.phase = 'held';
    return true;
  }

  /**
   * The native `start()` has been issued for `token` — events from here on
   * belong to it.
   */
  opened(token: symbol): void {
    if (this.owner !== token) return;
    this.phase = 'open';
  }

  /**
   * Ask the recogniser to finish, keeping ownership until `end`.
   *
   * Ownership is deliberately held across the stop: `stop()` (unlike `abort()`)
   * still delivers one last `result`, and dropping ownership here would make the
   * owner ignore the very words somebody spoke before tapping stop.
   */
  stop(token: symbol): void {
    if (this.owner !== token || this.phase !== 'open') return;
    this.phase = 'stopping';
    // A recogniser that answers a stop with silence must not hold the mic shut.
    this.arm();
    try {
      this.driver?.stop();
    } catch {
      // Already torn down natively — the guard timer settles it.
    }
  }

  /**
   * Give the mic back.
   *
   * Ownership is dropped *first* and synchronously, so the `error: aborted` that
   * `abort()` emits on the spot — and the `end` that follows it a few
   * milliseconds later — belong to nobody and are ignored by whichever panel is
   * mounted by then, rather than ending its capture for it.
   */
  release(token: symbol): void {
    if (this.owner !== token) return;
    const live = this.phase === 'open' || this.phase === 'stopping';
    this.owner = null;
    if (!live) {
      // Nothing was ever started natively (`held`): there is no teardown to wait
      // for, so the next capture may open immediately.
      this.settle();
      return;
    }
    this.phase = 'closing';
    // One `end` is now owed. Normally it lands while we are still `closing` and
    // settles it; if the guard timer gets there first and the next capture has
    // already opened, that late `end` must be swallowed rather than mistaken for
    // the new session's — which is the "second capture dies on somebody else's
    // ending" bug, arriving by the back door. The debt expires so a teardown
    // that never reports at all cannot swallow a genuine ending forever.
    this.owed = Date.now() + this.settleMs * 2;
    this.arm();
    try {
      this.driver?.abort();
    } catch {
      // Already torn down — the guard timer settles it.
    }
  }

  /**
   * The recogniser reported `error` on the owner's session.
   *
   * Every native error path is supposed to emit an `end` behind it, and holding
   * ownership until it lands is what lets the owner recognise its own ending.
   * But "supposed to" is not a guarantee across two platforms and several error
   * codes, so the guard timer is armed here too: a session that errors and then
   * says nothing more settles on its own instead of holding the mic shut.
   */
  errored(token: symbol): void {
    if (this.owner !== token || this.phase !== 'open') return;
    this.phase = 'stopping';
    this.arm();
  }

  /**
   * The recogniser reported `end`. **Returns whether `token`'s capture is the
   * one that just ended** — and so whether the caller should act on it.
   *
   * Every mounted surface hears the event, so each passes its own token and only
   * the owner's word is taken — otherwise an idle panel's handler, running first
   * in the subscription order, would close the session out from under the owner
   * and the owner would drop the final transcript. When there is no owner (the
   * trailing `end` of an aborted session) anybody may settle it, which is what
   * lets the next capture stop waiting.
   *
   * The return value is not a convenience. Asking `owns(token)` *before* calling
   * this is not the same question and gets the dangerous answer: once the guard
   * timer has settled an aborted session and a new capture has opened, the new
   * capture owns the mic, so `owns` says yes — and then the old session's late
   * `end` arrives and the caller closes a capture that has barely started. That
   * is the original "the mic only works once" bug reaching the screen by the
   * back door, with the arbiter's own state perfectly correct underneath. Only
   * this method knows the ending was somebody else's, so only this method can
   * answer, and it must be the single call the caller branches on.
   */
  ended(token?: symbol): boolean {
    const owed = this.owed !== 0 && Date.now() < this.owed;
    if (owed) {
      this.owed = 0;
      // This is the aborted session finally reporting in. Either way it is not
      // the caller's ending: it settles a teardown still in progress, or — if
      // the mic has moved on to somebody else in the meantime — it is swallowed.
      if (this.phase !== 'closing') return false;
      this.settle();
      return false;
    }
    if (this.phase === 'idle') return false;
    if (this.owner !== null && this.owner !== token) return false;
    // Null owner here is the trailing `end` of a session already given up on:
    // worth settling so the next capture may open, but nobody's to act on.
    const mine = this.owner === token;
    this.settle();
    return mine;
  }

  private settle(): void {
    if (this.guard !== null) {
      clearTimeout(this.guard);
      this.guard = null;
    }
    this.owner = null;
    this.phase = 'idle';
    const waiting = this.waiting;
    this.waiting = [];
    for (const resolve of waiting) resolve();
  }

  private arm(): void {
    if (this.guard !== null) clearTimeout(this.guard);
    this.guard = setTimeout(() => {
      this.guard = null;
      this.settle();
    }, this.settleMs);
  }

  private settled(): Promise<void> {
    if (this.phase === 'idle') return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }
}

/**
 * The app's one microphone.
 *
 * A module singleton because the thing it stands for is a singleton: there is
 * one recogniser in the process, whatever is on screen.
 */
export const speechMic = new SpeechMic();
