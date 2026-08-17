/**
 * One shared "the BYOK config changed" signal.
 *
 * Both the key vault (see aiKeys) and the per-key settings (see aiSettings) can
 * change what the AI access verdict should be — a key saved or removed, the key
 * paused, a token limit crossed. Rather than each screen wiring a callback to
 * each mutation, every mutation announces here and every consumer of the verdict
 * (see aiAccess) subscribes here. Kept in its own module so the vault and the
 * settings can both reach it without importing each other.
 */

type AiConfigListener = () => void;
const listeners = new Set<AiConfigListener>();

export function subscribeAiConfig(listener: AiConfigListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitAiConfigChanged(): void {
  for (const listener of listeners) listener();
}
