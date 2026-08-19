/**
 * The login screen — the app's front door for a returning person.
 *
 * Providers, phone and email: the ways back into an account that already
 * exists. The ways to *start* one (and the guest way in) live one tap behind
 * "Create account", on the separate sign-up page. The screen itself is the
 * shared `AuthFlow`, which both doors render; this file only picks the door.
 */

import { AuthFlow } from '@/components/AuthFlow';

export default function SignInScreen() {
  return <AuthFlow flow="login" />;
}
