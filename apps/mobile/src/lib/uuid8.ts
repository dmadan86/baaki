/**
 * A hex digest, shaped as a UUID.
 *
 * Kept apart from `importId` so it can be tested: the moment a module imports
 * expo-crypto it drags React Native in with it, and this is the part where
 * getting it wrong is silent — a malformed id is rejected by Postgres as a
 * column type, but a *well-formed* id that is not stable stops de-duplicating
 * anything and nobody finds out until there are two of every expense.
 */

/**
 * Version 8 — "custom", which is what this is: a name-based id from our own
 * hash. Not v4, because nothing here is random; not v5, which would have to
 * be SHA-1 over a namespace to deserve the name.
 */
export function uuidFromDigest(hex: string): string {
  const clean = hex.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (clean.length < 32) {
    // Padding it out would make two different inputs collide, which is the
    // one failure this whole mechanism exists to prevent.
    throw new Error(`Digest too short to make a UUID: ${clean.length} hex characters`);
  }
  const bytes = clean.slice(0, 32);
  // Version nibble and variant bits, per RFC 9562 §5.8.
  const version = `8${bytes.slice(13, 16)}`;
  const variant = `${'89ab'[parseInt(bytes[16] as string, 16) % 4]}${bytes.slice(17, 20)}`;
  return [bytes.slice(0, 8), bytes.slice(8, 12), version, variant, bytes.slice(20, 32)].join('-');
}
