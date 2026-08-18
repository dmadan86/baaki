/**
 * The rule the receipt-scan control obeys: a group may hold a set number of
 * receipts for free (an admin knob), and past that the scan is a paid feature —
 * unlock it by upgrading or by adding your own storage. The server answers "may
 * this group take one more receipt" over the `baaki_can_add_receipt` RPC; this
 * module turns that answer, and its loading state, into the small decisions the
 * two scan screens (add-expense, itemize) need, kept pure so they can be tested
 * without a renderer or the network.
 *
 * Deliberately the same shape as `groupPhotoGate` — the two gates guard
 * different features but wear the same three states, so a reader who knows one
 * knows the other.
 */

/** What the scan control should show. */
export type ReceiptCapStatus = 'loading' | 'allowed' | 'locked';

/**
 * The gate, from the RPC's boolean and whether it is still in flight. An
 * undefined answer counts as loading: better to hold on the neutral scan
 * affordance for a moment than to flash it and snatch it back — and, unlike the
 * photo gate, a failed fetch should not lock scanning that the server would
 * have allowed, so the caller decides its own fallback (see `useReceiptCap`).
 */
export function receiptCapStatus(
  canAdd: boolean | undefined,
  isLoading: boolean,
): ReceiptCapStatus {
  if (isLoading || canAdd === undefined) return 'loading';
  return canAdd ? 'allowed' : 'locked';
}

/** What tapping the scan button should do in each state. */
export type ReceiptTapAction = 'scan' | 'showLockedHint' | 'ignore';

/**
 * Tapping scan: read the bill only when allowed; when locked, point the person
 * at how to unlock it; while the answer is still loading, do nothing rather
 * than act on an unknown.
 */
export function receiptTapAction(status: ReceiptCapStatus): ReceiptTapAction {
  switch (status) {
    case 'allowed':
      return 'scan';
    case 'locked':
      return 'showLockedHint';
    case 'loading':
      return 'ignore';
  }
}
