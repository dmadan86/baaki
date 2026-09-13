/**
 * Which "send me a code" the sign-in card meant.
 *
 * One field takes an email or a phone number, and one link offers to send a
 * code to it — but the two codes come from different places and end in
 * different screens. Email is Supabase's and stays on the card. A phone code is
 * Firebase's and lives on `app/phone.tsx` (see `lib/phoneAuth` for why the two
 * were never folded into one flow). So something has to read what was typed and
 * decide, and that decision is here rather than in the component: mobile's
 * vitest renders nothing, and a branch that can send a person to a dead end is
 * exactly the kind worth pinning with tests.
 *
 * It used to have no phone branch at all. A number in the field — invited by
 * the field's own placeholder — got "Enter your email first", while the door
 * that would have worked sat below the fold, under the keyboard.
 */

/** A liberal check — enough to tell "this is an email, mail a code to it" from
 *  "this is a phone number or a username". The server is the real judge. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Enough of a number to be worth carrying to the phone screen.
 *
 * Liberal in the same way and for the same reason: 7 to 15 digits, optionally
 * behind a `+`, with the spaces and brackets people type ignored. It is
 * deliberately not `normalisePhone`, which refuses a number carrying no country
 * code — right when a number is about to be *used*, wrong here, where the phone
 * screen has a country picker and is happy to be handed bare digits.
 *
 * Erring generous costs a person one tap back. Erring strict is the dead end
 * this exists to remove. The ceiling is E.164's own: 15 digits, so a mistyped
 * essay does not get read as a number.
 */
export function looksLikePhone(value: string): boolean {
  const cleaned = value.trim().replace(/[^\d+]/g, '');
  return /^\+?\d{7,15}$/.test(cleaned);
}

/** Where a tap on a passwordless link should go. */
export enum CodeRoute {
  /** Supabase mails a code; the card turns to its own code stage. */
  Email = 'email',
  /** Firebase texts one; the number is carried to the phone screen. */
  Phone = 'phone',
  /** Neither — say so, and name only the kinds this build can actually do. */
  Nothing = 'nothing',
}

/**
 * Read the field, and say which code was asked for.
 *
 * `phoneOffered` is not a preference, it is a fact about the build and the
 * door: Firebase is a native module, so a binary made before it existed has no
 * phone sign-in in it at all, and sign-up does not offer the phone door by
 * ADR-006. When it is false the phone branch must not be taken — a link
 * promising a text where the tile beside it is absent would lead precisely
 * where that tile does not go — and the refusal is the honest email-only one
 * again.
 */
export function codeRouteFor(identifier: string, phoneOffered: boolean): CodeRoute {
  // Email first and unconditionally. An address is never a phone number, and
  // the email path works on every build, with no native module behind it.
  if (looksLikeEmail(identifier)) return CodeRoute.Email;
  if (phoneOffered && looksLikePhone(identifier)) return CodeRoute.Phone;
  return CodeRoute.Nothing;
}
