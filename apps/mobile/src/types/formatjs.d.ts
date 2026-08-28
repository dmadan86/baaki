/**
 * `@formatjs` ships types for each package root but not for its `/polyfill` and
 * `/locale-data/*` side-effect subpaths, so importing them for effect trips
 * TS2882 ("cannot find type declarations for side-effect import"). These are
 * pure side-effect modules with no exports; declaring them as such is all TS
 * needs. See src/lib/intlPolyfill.ts.
 */
declare module '@formatjs/intl-getcanonicallocales/polyfill';
declare module '@formatjs/intl-locale/polyfill';
declare module '@formatjs/intl-pluralrules/polyfill';
declare module '@formatjs/intl-pluralrules/locale-data/*';
declare module '@formatjs/intl-relativetimeformat/polyfill';
declare module '@formatjs/intl-relativetimeformat/locale-data/*';
