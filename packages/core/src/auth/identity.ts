/**
 * Deciding how somebody signs in — and, more importantly, how they stop being
 * a guest without losing everything.
 *
 * ADR-006 says an anonymous account is upgraded **in place**. That one
 * sentence is the whole reason this file exists, because the obvious code does
 * the opposite: a guest taps "sign in with Google", the app calls
 * `signInWithOAuth`, Supabase creates a *new* user, the session swaps, and the
 * trip they have been adding expenses to all week now belongs to an account
 * they can no longer reach. Nothing errors. The group is not deleted — it is
 * simply somebody else's, and the only way back is the anonymous session that
 * was just replaced.
 *
 * So the choice of call is not left to whichever screen is asking. Given who
 * is signed in and what they picked, `planAuth` returns the one correct
 * action, and the screens do as they are told. It is pure, so the case that
 * matters — a guest with data — can be tested without an account, a network,
 * or a phone.
 *
 * Nothing here talks to Supabase. It decides; the caller performs.
 */

export enum AuthMethod {
  EmailPassword = 'email_password',
  PhonePassword = 'phone_password',
  PhoneOtp = 'phone_otp',
  Google = 'google',
  Apple = 'apple',
}

/** The providers reached through an identity provider rather than a credential. */
export enum OAuthMethod {
  Google = 'google',
  Apple = 'apple',
}

/**
 * The OAuth providers, as their own enum. `AuthMethod` and `OAuthMethod` share
 * the same string values but are distinct enums, so an `AuthMethod` is mapped
 * across rather than assigned; `null` means this method is a credential, not an
 * identity provider.
 */
function asOAuth(method: AuthMethod): OAuthMethod | null {
  switch (method) {
    case AuthMethod.Google:
      return OAuthMethod.Google;
    case AuthMethod.Apple:
      return OAuthMethod.Apple;
    default:
      return null;
  }
}

/** Who is asking. */
export type Viewer =
  | { readonly kind: 'nobody' }
  | { readonly kind: 'guest'; readonly userId: string }
  | { readonly kind: 'user'; readonly userId: string };

export type AuthAction =
  /** Brand new account with credentials. */
  | { readonly call: 'signUp'; readonly method: AuthMethod }
  /** Existing account, prove it. */
  | { readonly call: 'signInWithPassword'; readonly method: AuthMethod }
  | { readonly call: 'signInWithOtp'; readonly method: 'phone_otp' }
  /**
   * A fresh sign-in through an identity provider. How the caller performs it is
   * its own business — Apple on an iPhone is the native sheet and an id token,
   * Apple anywhere else is the same web redirect Google uses — but it is only
   * ever *this* action, and this action is only ever reached by somebody with
   * no account to lose.
   */
  | { readonly call: 'signInWithOAuth'; readonly method: OAuthMethod }
  /**
   * The upgrade. `updateUser` adds an email or phone to the account that is
   * already signed in; `linkIdentity` does the same for an OAuth provider.
   * Both keep the user id, which is what keeps the groups.
   */
  | { readonly call: 'updateUser'; readonly method: AuthMethod }
  | { readonly call: 'linkIdentity'; readonly method: OAuthMethod };

export class IdentityError extends Error {
  constructor(
    readonly code:
      | 'PHONE_NEEDS_COUNTRY_CODE'
      | 'PHONE_NOT_VALID'
      | 'EMAIL_NOT_VALID'
      | 'PASSWORD_TOO_SHORT'
      | 'PASSWORD_TOO_COMMON',
    message: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

/**
 * The rule, in one function.
 *
 * A guest never signs up and never signs in — both would mint or move to a
 * different account. A guest only ever *adds* credentials to the account they
 * already have.
 */
export function planAuth(
  viewer: Viewer,
  method: AuthMethod,
  intent: 'sign_in' | 'sign_up' = 'sign_in',
): AuthAction {
  const oauth = asOAuth(method);

  if (viewer.kind === 'guest') {
    // Whatever the screen thought it was doing, this is an upgrade.
    return oauth ? { call: 'linkIdentity', method: oauth } : { call: 'updateUser', method };
  }

  if (viewer.kind === 'user') {
    // Already a real account. Adding a second way in is still a link, never a
    // sign-up — somebody with an email adding Google must not end up with two
    // accounts and half their groups in each.
    return oauth ? { call: 'linkIdentity', method: oauth } : { call: 'updateUser', method };
  }

  switch (method) {
    case AuthMethod.Google:
    case AuthMethod.Apple:
      return { call: 'signInWithOAuth', method: oauth! };
    case AuthMethod.PhoneOtp:
      return { call: 'signInWithOtp', method: 'phone_otp' };
    default:
      return intent === 'sign_up'
        ? { call: 'signUp', method }
        : { call: 'signInWithPassword', method };
  }
}

/**
 * A number, in E.164 and nothing else.
 *
 * No default country. Baaki is India-first, so +91 is the tempting default and
 * exactly the wrong one: the person most likely to be typing a number into a
 * splitting app is on a trip, entering a friend's foreign number, and a silent
 * +91 would send their invite to a stranger in Delhi. The same rule as
 * `group_members.invite_phone` in the database, which is the other place a
 * number can arrive.
 */
export function normalisePhone(raw: string): string {
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (!cleaned.startsWith('+')) {
    throw new IdentityError(
      'PHONE_NEEDS_COUNTRY_CODE',
      'Start with a country code, like +91 for India',
    );
  }
  if (!/^\+[1-9]\d{7,14}$/.test(cleaned)) {
    throw new IdentityError('PHONE_NOT_VALID', 'That does not look like a phone number');
  }
  return cleaned;
}

/**
 * The same E.164 number, but a bare national one is read in a known region.
 *
 * `normalisePhone` refuses a number with no country code on purpose — a silent
 * `+91` on a friend's foreign number sends the invite to a stranger. That
 * refusal is right for a sign-in field, where the person is typing their *own*
 * number and can be asked to add the code. It is wrong for the everyday act of
 * adding a friend by their local number, which is how every messaging app on
 * the phone already works: the number is read in *your* region, not guessed.
 *
 * So this takes the region as an explicit argument — the device, account or
 * group country turned into a dialing code by the caller — rather than assuming
 * one. The no-blind-default property is preserved: with no region to borrow
 * (`defaultDialCode` null), it falls straight back to the same refusal. The
 * region is the whole point; a caller that cannot name one gets no number.
 *
 *  - `+91 98765 43210`      → `+919876543210` (already coded; region ignored)
 *  - `9535621101`, `+91`    → `+919535621101` (bare national, read in region)
 *  - `09535621101`, `+91`   → `+919535621101` (trunk 0 dropped first)
 *  - `9535621101`, null     → throws PHONE_NEEDS_COUNTRY_CODE (no region)
 *
 * Pure and deterministic: same inputs, same output or same throw, no clock, no
 * device, no network.
 */
export function normalisePhoneInRegion(raw: string, defaultDialCode: string | null): string {
  const cleaned = raw.replace(/[^\d+]/g, '');
  // Already carries a country code: the region default is irrelevant and the
  // ordinary rule applies unchanged.
  if (cleaned.startsWith('+')) return normalisePhone(cleaned);
  // No code and no region to lend one — the same honest refusal as before.
  if (!defaultDialCode) return normalisePhone(cleaned);
  // A bare national number, read in the caller's own region: drop the single
  // trunk "0" some countries write before a local number (09876… → 9876…),
  // prepend the region's dialing code, and validate as any other E.164 number.
  const national = cleaned.replace(/^0/, '');
  return normalisePhone(`${defaultDialCode}${national}`);
}

/** Lowercased and trimmed, because a login that is case-sensitive is a bug report. */
export function normaliseEmail(raw: string): string {
  const cleaned = raw.trim().toLowerCase();
  // Deliberately loose. A stricter pattern rejects real addresses, and the
  // only test that settles it is whether the confirmation mail arrives.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(cleaned)) {
    throw new IdentityError('EMAIL_NOT_VALID', 'That does not look like an email address');
  }
  return cleaned;
}

/**
 * Passwords guarding a shared ledger.
 *
 * Length, and a short list of the passwords everybody picks. No character-class
 * rules: they push people towards `Password1!` and away from a long phrase,
 * which is worse on both counts.
 */
const OBVIOUS = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  '1234567890',
  'qwertyui',
  'iloveyou',
  'baaki123',
  'letmein1',
  'welcome1',
  'abcd1234',
]);

export const MIN_PASSWORD_LENGTH = 8;

export function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new IdentityError(
      'PASSWORD_TOO_SHORT',
      `Use at least ${MIN_PASSWORD_LENGTH} characters — a phrase is easier to remember than a puzzle`,
    );
  }
  if (OBVIOUS.has(password.toLowerCase())) {
    throw new IdentityError(
      'PASSWORD_TOO_COMMON',
      'That is one of the first passwords anyone tries',
    );
  }
}

/**
 * The name Apple gives back, out of the three parts it splits it into.
 *
 * Apple hands over a name on the **first authorization only** — never on a
 * reinstall, never on a second device — and the id token carries none at all.
 * So this runs exactly once per person, on a device nobody is watching, and
 * whatever it produces is what everybody they split a bill with sees from then
 * on. There is no second authorization to correct it from.
 *
 * Any part may be absent and often is: a mononym arrives as a given name and
 * nothing else, which is ordinary in the app's first market. Apple also pads
 * with empty strings rather than omitting keys, so joining blindly puts two
 * spaces in the middle of a real person's name.
 *
 * Null, not an empty string. The caller uses it to decide whether there is
 * anything worth writing at all, and '' would replace a display name with
 * nothing — which is the common case, since every sign-in after the first
 * carries no name.
 */
export function appleFullName(
  parts: {
    readonly givenName?: string | null;
    readonly middleName?: string | null;
    readonly familyName?: string | null;
  } | null,
): string | null {
  const named = [parts?.givenName, parts?.middleName, parts?.familyName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return named.length > 0 ? named.join(' ') : null;
}

/**
 * What the person typed into a single field: an email, or a number.
 *
 * One field rather than two, because asking somebody to first declare which
 * kind of thing they are about to type, and then type it, is a question the
 * text itself already answers.
 */
export function readIdentifier(raw: string): { kind: 'email' | 'phone'; value: string } {
  const trimmed = raw.trim();
  if (trimmed.includes('@')) return { kind: 'email', value: normaliseEmail(trimmed) };
  return { kind: 'phone', value: normalisePhone(trimmed) };
}
