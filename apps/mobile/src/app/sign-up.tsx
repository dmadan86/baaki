/**
 * The sign-up page — where a new person chooses how to start.
 *
 * Reached from "Create account" on the login screen. Same providers, phone and
 * email as login, but pointed at registering rather than returning, and this is
 * where the guest way in lives (ADR-006 addendum): nobody is made to hand over
 * a detail before they can split a bill. The screen is the shared `AuthFlow`.
 */

import { AuthFlow } from '@/components/AuthFlow';

export default function SignUpScreen() {
  return <AuthFlow flow="signup" />;
}
