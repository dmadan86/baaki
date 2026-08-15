/**
 * In-memory AsyncStorage for the vitest run.
 *
 * The real package (v3) ships only an ESM build for the react-native@0.86 peer
 * combo, and that build uses extensionless relative imports that Node's native
 * ESM resolver rejects — so merely importing it (some `@/lib` modules do, at
 * collection time) crashes the whole suite under vitest. None of the pure-logic
 * tests here actually exercise storage; they only need the module to load. This
 * stub gives them a working, side-effect-free implementation and keeps the real
 * native module for the device (Metro) build, which resolves it correctly.
 */

const store = new Map<string, string>();

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return store.has(key) ? (store.get(key) as string) : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    store.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    store.delete(key);
  },
  async removeMany(keys: string[]): Promise<void> {
    for (const key of keys) store.delete(key);
  },
  async getMany(keys: string[]): Promise<Record<string, string | null>> {
    return Object.fromEntries(keys.map((key) => [key, store.has(key) ? store.get(key)! : null]));
  },
  async setMany(entries: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) store.set(key, value);
  },
  async getAllKeys(): Promise<string[]> {
    return [...store.keys()];
  },
  async clear(): Promise<void> {
    store.clear();
  },
};

export default AsyncStorage;
