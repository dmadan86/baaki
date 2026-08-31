/**
 * Handing the one microphone from one capture to the next.
 *
 * The device bug these are written against is always the same shape: the first
 * utterance is heard and the second one is not. Every case below is a way that
 * used to happen — a previous session's ending closing the new one, a teardown
 * running after the new start and destroying it, two starts issued at once, or a
 * claim nobody ever gave back. None of it can be seen on the emulator (no live
 * mic), so the sequencing is tested here instead of asserted on a device.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SpeechMic } from '@/lib/speechMic';

const SETTLE = 1000;

let driver: { stop: Mock<() => void>; abort: Mock<() => void> };
let mic: SpeechMic;

beforeEach(() => {
  vi.useFakeTimers();
  driver = { stop: vi.fn<() => void>(), abort: vi.fn<() => void>() };
  mic = new SpeechMic(SETTLE);
  mic.attach(driver);
});

afterEach(() => {
  vi.useRealTimers();
});

/** A capture that runs to completion: claimed, opened, and ended by the mic. */
async function fullCapture(token: symbol): Promise<void> {
  await mic.acquire(token);
  mic.opened(token);
  mic.ended(token);
}

describe('one capture after another', () => {
  it('hands the mic straight to the next capture when the last one ended', async () => {
    const first = Symbol('first');
    await fullCapture(first);

    expect(mic.state).toBe('idle');
    expect(mic.owns(first)).toBe(false);
    // The completed session is already torn down natively; aborting it again is
    // what used to race the next start and leave the second capture silent.
    expect(driver.abort).not.toHaveBeenCalled();

    const second = Symbol('second');
    await expect(mic.acquire(second)).resolves.toBe(true);
    expect(mic.owns(second)).toBe(true);
  });

  it('gives the mic back on unmount without aborting a session that ended', async () => {
    const first = Symbol('first');
    await fullCapture(first);
    // The panel unmounts a moment later, as the screen moves on.
    mic.release(first);

    expect(driver.abort).not.toHaveBeenCalled();
    expect(mic.state).toBe('idle');
  });

  it('makes the next capture wait for an aborted one to finish tearing down', async () => {
    const first = Symbol('first');
    await mic.acquire(first);
    mic.opened(first);

    // The panel is dismissed mid-sentence: it gives the mic back, which aborts.
    mic.release(first);
    expect(driver.abort).toHaveBeenCalledTimes(1);
    expect(mic.state).toBe('closing');

    // The replacement panel asks for the mic straight away. It must not get it
    // yet: the abort's teardown has not run, and it would destroy whatever
    // recogniser it finds when it does — including one started in between.
    const second = Symbol('second');
    let claimed: boolean | null = null;
    void mic.acquire(second).then((granted) => {
      claimed = granted;
    });
    await Promise.resolve();
    expect(claimed).toBeNull();

    // The teardown reports in. Now, and only now, the next capture may open.
    mic.ended();
    await vi.advanceTimersByTimeAsync(0);
    expect(claimed).toBe(true);
    expect(mic.owns(second)).toBe(true);
  });

  it('stops waiting on a teardown that never reports', async () => {
    const first = Symbol('first');
    await mic.acquire(first);
    mic.opened(first);
    // Nobody is left mounted to hear the `end` — the screen was left entirely.
    mic.release(first);

    const second = Symbol('second');
    let claimed: boolean | null = null;
    void mic.acquire(second).then((granted) => {
      claimed = granted;
    });
    await vi.advanceTimersByTimeAsync(SETTLE - 1);
    expect(claimed).toBeNull();
    // A missing event must cost a pause, never the microphone.
    await vi.advanceTimersByTimeAsync(1);
    expect(claimed).toBe(true);
  });
});

describe('whose event is this', () => {
  it('ignores the ending a torn-down session reports late', async () => {
    const first = Symbol('first');
    await mic.acquire(first);
    mic.opened(first);
    mic.release(first);

    // The teardown is slow; the guard timer gives up and the next capture opens.
    const second = Symbol('second');
    await vi.advanceTimersByTimeAsync(SETTLE);
    await mic.acquire(second);
    mic.opened(second);

    // The first session's `end` finally lands. It is not the second's, and
    // closing the second on it is exactly the bug being fixed.
    mic.ended(second);
    expect(mic.owns(second)).toBe(true);
    expect(mic.state).toBe('open');
  });

  it('will not let an idle surface close the capture somebody else is running', async () => {
    const owner = Symbol('owner');
    const bystander = Symbol('bystander');
    await mic.acquire(owner);
    mic.opened(owner);

    // Every mounted surface hears every event; a bystander reporting the ending
    // first must not clear ownership, or the owner drops its final transcript.
    mic.ended(bystander);
    expect(mic.owns(owner)).toBe(true);

    mic.ended(owner);
    expect(mic.owns(owner)).toBe(false);
  });

  it('refuses the mic to a second surface while one is capturing', async () => {
    const owner = Symbol('owner');
    const other = Symbol('other');
    await mic.acquire(owner);
    mic.opened(owner);

    await expect(mic.acquire(other)).resolves.toBe(false);
    // Refused, not stolen: aborting the live capture would race its next event.
    expect(driver.abort).not.toHaveBeenCalled();
    expect(mic.owns(owner)).toBe(true);
  });
});

describe('the paths that never open the mic', () => {
  it('frees a claim that never reached the recogniser, with nothing to abort', async () => {
    // A refused permission, or an unmount while the permission sheet is up: the
    // mic was claimed but never started. A claim nobody gives back is a mic
    // nothing can reopen.
    const first = Symbol('first');
    await mic.acquire(first);
    mic.release(first);

    expect(driver.abort).not.toHaveBeenCalled();
    expect(mic.state).toBe('idle');

    const second = Symbol('second');
    await expect(mic.acquire(second)).resolves.toBe(true);
  });

  it('ignores a release from a surface that does not hold the mic', async () => {
    const owner = Symbol('owner');
    const bystander = Symbol('bystander');
    await mic.acquire(owner);
    mic.opened(owner);

    // An idle row unmounting as a list changes must not abort somebody's capture.
    mic.release(bystander);
    expect(driver.abort).not.toHaveBeenCalled();
    expect(mic.owns(owner)).toBe(true);
  });
});

describe('stopping', () => {
  it('keeps the session across a stop so the last words still land', async () => {
    const owner = Symbol('owner');
    await mic.acquire(owner);
    mic.opened(owner);

    mic.stop(owner);
    expect(driver.stop).toHaveBeenCalledTimes(1);
    // stop() still delivers one final result; dropping ownership here would make
    // the owner ignore the very words spoken before the tap.
    expect(mic.owns(owner)).toBe(true);

    mic.ended(owner);
    expect(mic.state).toBe('idle');
  });

  it('settles a stop the recogniser never answers', async () => {
    const owner = Symbol('owner');
    await mic.acquire(owner);
    mic.opened(owner);
    mic.stop(owner);

    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(mic.state).toBe('idle');
  });

  it('settles an error whose ending never follows it', async () => {
    const owner = Symbol('owner');
    await mic.acquire(owner);
    mic.opened(owner);

    mic.errored(owner);
    // Ownership is held for the `end` that is supposed to follow…
    expect(mic.owns(owner)).toBe(true);
    // …but a platform that never sends one must not hold the mic shut.
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(mic.state).toBe('idle');
  });
});

describe('two taps at once', () => {
  it('gives the mic to one of two simultaneous claims, not both', async () => {
    const first = Symbol('first');
    const second = Symbol('second');
    const [a, b] = await Promise.all([mic.acquire(first), mic.acquire(second)]);

    expect([a, b]).toEqual([true, false]);
    expect(mic.owns(first)).toBe(true);
  });

  it('survives a claim released while a second one is still waiting', async () => {
    const first = Symbol('first');
    await mic.acquire(first);
    mic.opened(first);
    mic.release(first);

    const second = Symbol('second');
    const third = Symbol('third');
    const pending = Promise.all([mic.acquire(second), mic.acquire(third)]);
    mic.ended();
    const [a, b] = await pending;

    // Exactly one of them opens the recogniser; the other is told no rather than
    // starting a second one on top of it.
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});
