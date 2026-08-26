/** Returns whether the initial OS query should still seed the reduced-motion state. */
export function shouldApplyInitialReducedMotionPreference(
  mounted: boolean,
  receivedEvent: boolean,
): boolean {
  return mounted && !receivedEvent;
}
