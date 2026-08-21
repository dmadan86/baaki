/**
 * A one-shot handoff between a screen that needs contacts and the full-screen
 * contact picker.
 *
 * The picker used to be embedded inline under an "add people" section — a
 * 480pt address book crammed into the middle of a form. Pulled out into its own
 * route it has the whole screen to work with (a letter rail needs the height),
 * but a pushed route cannot hand a value back the way a callback can. So the
 * caller leaves its intent here first: who is already picked, and what to do
 * with the answer. The picker reads it on open, and calls `onPicked` with the
 * ticked people before it closes.
 *
 * Deliberately a module singleton, not React state: it has to outlive the
 * navigation that carries the caller off-screen and back. It holds exactly one
 * request — there is only ever one picker open — and is cleared once answered
 * or abandoned, so a stale request can never leak into the next open.
 */

import type { PickedContact } from '@/components/ContactPicker';

export interface ContactRequest {
  /** Whoever the caller has already chosen, so the picker opens ticked. */
  readonly initial: readonly PickedContact[];
  /**
   * Addresses already in the group — shown greyed rather than hidden, so it is
   * obvious why they cannot be picked again. Omitted when nothing is off-limits.
   */
  readonly existing?: ReadonlySet<string>;
  /** What the caller does with the people ticked, once the picker confirms. */
  readonly onPicked: (people: readonly PickedContact[]) => void;
}

let pending: ContactRequest | null = null;

/** Stash the caller's intent, then navigate to `/contact-picker`. */
export function requestContacts(request: ContactRequest): void {
  pending = request;
}

/**
 * Take the open request and clear it in the same step — the picker reads this
 * once on mount and thereafter owns the captured request, so nothing can carry
 * over to the next open whether it confirms or is backed out of.
 */
export function takeContactRequest(): ContactRequest | null {
  const request = pending;
  pending = null;
  return request;
}
