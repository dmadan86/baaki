/**
 * A stand-in for `@expo/vector-icons/Ionicons` under vitest.
 *
 * The real package pulls the native font/asset pipeline, which does not load in
 * a plain Node run. The pure modules tested here (e.g. `components/tagIcons.ts`)
 * only reference `Ionicons.glyphMap` in a *type* position — `keyof typeof
 * Ionicons.glyphMap` — so a bare object with a `glyphMap` is enough to let them
 * import. The real component is used on the device (Metro) build.
 */

const Ionicons = { glyphMap: {} as Record<string, number> };

export default Ionicons;
