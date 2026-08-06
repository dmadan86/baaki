/**
 * The private things a report might carry, kept in a file of their own.
 *
 * Not tidiness. Sentry's `ContextLines` integration attaches the source lines
 * either side of the throw site, so a literal written next to the
 * `captureException` call ends up in the envelope as *source*, and the test
 * that searches the wire for it finds its own fixture. Defining them here keeps
 * the test file's source clean of the strings it is looking for, so a hit is
 * always a real leak.
 */

export const SECRETS = {
  description: 'Dinner with Asha',
  who: 'Asha',
  email: 'asha@example.co.in',
  phone: '+919876543210',
  vpa: '9876543210@ybl',
  inviteToken: 'k3m2p1q8z'.repeat(8),
};

/** Kept, because a report without these is not worth the round trip. */
export const DIAGNOSIS = {
  amount: '45000',
  userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
};
