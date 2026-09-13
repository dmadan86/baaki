/**
 * The web half of the bank-message store: there isn't one.
 *
 * Reading a phone's messages is an Android capability and nothing else — there
 * is no browser API for it and never will be — so on web every function here
 * answers as an empty store rather than opening a database that would hold
 * nothing. Metro picks this file over `smsMessageStore.ts` on web, the same way
 * `sync/driver.web.ts` stands in for the native store.
 *
 * Written as real no-ops rather than throwing, so the sign-out wipe
 * (`sync/provider.tsx`) can call `forgetEverything` unconditionally: a wipe with
 * a branch in it is a wipe that will one day take the wrong branch.
 *
 * The types are re-exported from the native module so there is one definition
 * of a stored message, not two that drift.
 */

import type { IncomingSms, StoredSms } from './smsMessageTypes';

// From the shared types module, never from the native store — importing that
// here is exactly what would drag expo-sqlite's WASM build into a web bundle.
export { SmsSettlement } from './smsMessageTypes';
export type { IncomingSms, StoredSms } from './smsMessageTypes';

export async function saveMessages(
  _ownerId: string,
  _messages: readonly IncomingSms[],
): Promise<number> {
  return 0;
}

export async function loadMessages(_ownerId: string): Promise<StoredSms[]> {
  return [];
}

export async function knownKeys(_ownerId: string): Promise<Set<string>> {
  return new Set();
}

export async function settleMessages(): Promise<void> {}

export async function unsettleMessage(): Promise<void> {}

export async function forgetMessage(): Promise<void> {}

export async function forgetMessagesForOwner(): Promise<void> {}

export async function forgetEverything(): Promise<void> {}
