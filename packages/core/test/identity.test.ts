/**
 * Signing in, and the one case that must never be got wrong.
 *
 * A guest has real data: a trip, a week of expenses, people who owe them
 * money. If "sign in with Google" calls `signInWithOAuth`, Supabase makes a
 * new user, the session swaps, and all of it belongs to an account they cannot
 * reach. Nothing errors. Nothing is deleted. It is simply gone, and the only
 * way back was the anonymous session that was just replaced.
 *
 * Every test in the first block is that failure, from a different angle.
 */

import { describe, expect, it } from 'vitest';

import {
  appleFullName,
  checkPassword,
  IdentityError,
  normaliseEmail,
  normalisePhone,
  planAuth,
  readIdentifier,
  AuthMethod,
  type Viewer,
} from '../src/index';

const GUEST: Viewer = { kind: 'guest', userId: 'u-guest' };
const USER: Viewer = { kind: 'user', userId: 'u-real' };
const NOBODY: Viewer = { kind: 'nobody' };

const EVERY_METHOD: AuthMethod[] = [
  AuthMethod.EmailPassword,
  AuthMethod.PhonePassword,
  AuthMethod.PhoneOtp,
  AuthMethod.Google,
  AuthMethod.Apple,
];

describe('a guest is upgraded, never replaced', () => {
  it.each(EVERY_METHOD)('%s adds to the account they already have', (method) => {
    const action = planAuth(GUEST, method);
    expect(['updateUser', 'linkIdentity']).toContain(action.call);
  });

  it.each(EVERY_METHOD)('%s never signs them up or in as somebody new', (method) => {
    // This is the whole file. A guest reaching signUp, signInWithPassword or
    // signInWithOAuth loses their groups.
    const action = planAuth(GUEST, method);
    expect(['signUp', 'signInWithPassword', 'signInWithOtp', 'signInWithOAuth']).not.toContain(
      action.call,
    );
  });

  it('links Google rather than signing in with it', () => {
    expect(planAuth(GUEST, AuthMethod.Google)).toEqual({ call: 'linkIdentity', method: 'google' });
  });

  it('links Apple rather than signing in with it', () => {
    // Apple is the sharper version of the same trap. On an iPhone the tempting
    // implementation is the native sheet plus `signInWithIdToken`, which has no
    // "link" mode at all — it always resolves to whichever account owns that
    // Apple ID, and for a guest that is a brand new one. Returning `linkIdentity`
    // here is what sends the caller down the web flow instead, which is the only
    // one that can add a provider to the session already held.
    expect(planAuth(GUEST, AuthMethod.Apple)).toEqual({ call: 'linkIdentity', method: 'apple' });
  });

  it('ignores a screen that thinks it is a sign-up', () => {
    // The screen does not get a say. Whatever it believes it is doing, a guest
    // with data can only ever be upgraded.
    expect(planAuth(GUEST, AuthMethod.EmailPassword, 'sign_up').call).toBe('updateUser');
    expect(planAuth(GUEST, AuthMethod.EmailPassword, 'sign_in').call).toBe('updateUser');
  });
});

describe('somebody who already has an account', () => {
  it.each(EVERY_METHOD)('%s adds a second way in, not a second account', (method) => {
    // Somebody with an email who adds Google must not end up with two accounts
    // and half their groups in each.
    const action = planAuth(USER, method);
    expect(['updateUser', 'linkIdentity']).toContain(action.call);
  });
});

describe('somebody with no account at all', () => {
  it('signs in with a password', () => {
    expect(planAuth(NOBODY, AuthMethod.EmailPassword)).toEqual({
      call: 'signInWithPassword',
      method: 'email_password',
    });
  });

  it('signs up when that is what they asked for', () => {
    expect(planAuth(NOBODY, AuthMethod.EmailPassword, 'sign_up')).toEqual({
      call: 'signUp',
      method: 'email_password',
    });
  });

  it('sends a code for phone OTP whichever they asked for', () => {
    // There is no separate sign-up for an OTP: the code both proves the number
    // and creates the account.
    expect(planAuth(NOBODY, AuthMethod.PhoneOtp).call).toBe('signInWithOtp');
    expect(planAuth(NOBODY, AuthMethod.PhoneOtp, 'sign_up').call).toBe('signInWithOtp');
  });

  it('goes to the provider for Google', () => {
    expect(planAuth(NOBODY, AuthMethod.Google).call).toBe('signInWithOAuth');
  });

  it('goes to the provider for Apple', () => {
    expect(planAuth(NOBODY, AuthMethod.Apple)).toEqual({
      call: 'signInWithOAuth',
      method: 'apple',
    });
  });

  it('will not be talked into a sign-up for either provider', () => {
    // There is no such thing as signing *up* with a provider: the first time
    // through is the account being made. A screen passing 'sign_up' must not
    // reach `signUp`, which wants a password there is none of.
    expect(planAuth(NOBODY, AuthMethod.Google, 'sign_up').call).toBe('signInWithOAuth');
    expect(planAuth(NOBODY, AuthMethod.Apple, 'sign_up').call).toBe('signInWithOAuth');
  });
});

describe('the native Apple sheet is unreachable for anybody with data', () => {
  // `signInWithIdToken` is the only call in the app that cannot be made safe by
  // the caller: it takes a token from Apple and resolves it to whichever
  // account holds that Apple ID, with no way to say "add this to the session I
  // already have". `apps/mobile/src/lib/auth.tsx` may only use it on the
  // `signInWithOAuth` branch, so that branch has to stay unreachable for a
  // guest or a user. This is that guarantee, stated where it is enforced.
  it.each([GUEST, USER])('never returns signInWithOAuth for %o', (viewer) => {
    expect(planAuth(viewer, AuthMethod.Apple).call).not.toBe('signInWithOAuth');
    expect(planAuth(viewer, AuthMethod.Apple, 'sign_up').call).not.toBe('signInWithOAuth');
  });
});

describe('phone numbers', () => {
  it('keeps a number in E.164', () => {
    expect(normalisePhone('+91 98765 43210')).toBe('+919876543210');
  });

  it('strips whatever punctuation a keyboard produced', () => {
    expect(normalisePhone('+91-98765-43210')).toBe('+919876543210');
    expect(normalisePhone('+91 (98765) 43210')).toBe('+919876543210');
  });

  it('refuses a number with no country code rather than assuming India', () => {
    // The person typing a number into a splitting app is often on a trip,
    // entering a friend's foreign number. A silent +91 sends it to a stranger.
    expect(() => normalisePhone('09876543210')).toThrow(IdentityError);
    expect(() => normalisePhone('09876543210')).toThrow(/country code/);
  });

  it('refuses something that is not a number', () => {
    expect(() => normalisePhone('+12')).toThrow(/phone number/);
    expect(() => normalisePhone('+0123456789')).toThrow(/phone number/);
  });

  it('takes a number from anywhere, not only India', () => {
    expect(normalisePhone('+1 415 555 2671')).toBe('+14155552671');
    expect(normalisePhone('+44 20 7946 0958')).toBe('+442079460958');
  });
});

describe('email addresses', () => {
  it('lowercases and trims', () => {
    // A login that is case-sensitive is a bug report.
    expect(normaliseEmail('  Asha@Example.COM ')).toBe('asha@example.com');
  });

  it('refuses what is plainly not an address', () => {
    for (const bad of ['asha', 'asha@', '@example.com', 'a b@example.com', 'asha@example']) {
      expect(() => normaliseEmail(bad)).toThrow(IdentityError);
    }
  });

  it('takes the odd-looking addresses that are real', () => {
    expect(normaliseEmail('asha+goa@example.co.in')).toBe('asha+goa@example.co.in');
    expect(normaliseEmail("o'neill@example.org")).toBe("o'neill@example.org");
  });
});

describe('passwords', () => {
  it('wants length, not punctuation', () => {
    // Character-class rules push people to Password1! and away from a phrase.
    expect(() => checkPassword('correct horse battery staple')).not.toThrow();
    expect(() => checkPassword('short1')).toThrow(/at least 8/);
  });

  it('refuses the ones everybody picks', () => {
    expect(() => checkPassword('password123')).toThrow(/first passwords anyone tries/);
    expect(() => checkPassword('PASSWORD123')).toThrow(IdentityError);
  });
});

describe('the name Apple gives back, once', () => {
  // This runs exactly once per person, on a device nobody is watching, and
  // whatever it produces is what their whole group sees from then on. There is
  // no second authorization to correct it from.

  it('joins the parts somebody actually has', () => {
    expect(appleFullName({ givenName: 'Asha', familyName: 'Ravi' })).toBe('Asha Ravi');
    expect(appleFullName({ givenName: 'Asha', middleName: 'K', familyName: 'Ravi' })).toBe(
      'Asha K Ravi',
    );
  });

  it('keeps a mononym whole', () => {
    // Single-name people are ordinary in the app's first market. A name is not
    // required to have two halves.
    expect(appleFullName({ givenName: 'Rajinikanth' })).toBe('Rajinikanth');
    expect(appleFullName({ familyName: 'Ravi' })).toBe('Ravi');
  });

  it('does not leave a gap where an empty part was', () => {
    // Apple pads with empty strings rather than omitting keys. Joining blindly
    // gives "Asha  Ravi", and that is then shown to everybody in the group.
    expect(appleFullName({ givenName: 'Asha', middleName: '', familyName: 'Ravi' })).toBe(
      'Asha Ravi',
    );
    expect(appleFullName({ givenName: 'Asha', middleName: '   ', familyName: 'Ravi' })).toBe(
      'Asha Ravi',
    );
  });

  it('trims the parts rather than the join', () => {
    expect(appleFullName({ givenName: '  Asha ', familyName: ' Ravi  ' })).toBe('Asha Ravi');
  });

  it('says null rather than empty when there is no name at all', () => {
    // The ordinary case on every sign-in after the first. The difference
    // matters: '' would replace a display name with nothing.
    expect(appleFullName(null)).toBeNull();
    expect(appleFullName({})).toBeNull();
    expect(appleFullName({ givenName: '', middleName: '', familyName: '' })).toBeNull();
    expect(appleFullName({ givenName: null, familyName: null })).toBeNull();
  });
});

describe('one field for either', () => {
  it('reads an email as an email', () => {
    expect(readIdentifier(' Asha@Example.com ')).toEqual({
      kind: 'email',
      value: 'asha@example.com',
    });
  });

  it('reads a number as a number', () => {
    expect(readIdentifier('+91 98765 43210')).toEqual({ kind: 'phone', value: '+919876543210' });
  });

  it('complains about the number, not about the format of the field', () => {
    // Asking "email or phone?" and then asking them to type it is a question
    // the text already answers — but the error still has to be the useful one.
    expect(() => readIdentifier('9876543210')).toThrow(/country code/);
  });
});
