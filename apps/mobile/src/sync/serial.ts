/**
 * One at a time, please.
 *
 * Both local stores are shared by callers that do not know about each other:
 * a flush persisting a server answer, a keystroke saving a draft, and a tap
 * queueing a mutation can all be in flight in the same tick. Neither store
 * survives that on its own.
 *
 * On native it is worse than a lost write. `withTransactionAsync` is, in
 * expo-sqlite's own source, `execAsync('BEGIN')` … `execAsync('COMMIT')` on the
 * *shared* connection — so a second caller's `BEGIN` lands inside the first
 * one's transaction and SQLite refuses it. The failure then rolls back work
 * that belonged to somebody else, which for the mutation queue means quietly
 * dropping something the person was told had been saved.
 *
 * On web the store is read-modify-write over AsyncStorage, so two overlapping
 * `putRows` calls simply lose one of them.
 *
 * The fix for both is the same and belongs in one place: a promise chain that
 * every public store method passes through, so the disk sees one operation at
 * a time in the order it was asked for.
 */

/** A queue of one. Tasks run in the order they were handed over. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    // The same `task` on both arms: a failure ahead of us in the queue is that
    // caller's problem, not a reason to refuse to run. Without this a single
    // rejected write would wedge the store for the life of the process.
    const result = this.tail.then(task, task);

    // The chain remembers only that the slot is free, never why it freed up.
    // Keeping the rejection here instead would surface it a second time, with
    // nobody waiting on it, as an unhandled promise rejection.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }
}
