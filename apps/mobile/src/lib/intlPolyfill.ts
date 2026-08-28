/**
 * Filling in the `Intl` features Hermes does not ship.
 *
 * The Android Hermes build carries `Intl.NumberFormat` and `Intl.DateTimeFormat`
 * (so money and absolute dates format natively) but not `Intl.RelativeTimeFormat`
 * — the constructor is simply absent. Every relative stamp in the app
 * ("2 days ago", "yesterday") feature-detects it and falls back to an absolute
 * date when it is missing, so the feed reads "Aug 27, 8:16 PM" instead of the
 * skimmable relative time it was built for. That degrade is app-wide, not just
 * the activity feed: the dashboard, the ledger and every "last active" line lose
 * their relative wording on the same devices.
 *
 * `@formatjs` backfills it in pure JS (no native rebuild — ships over OTA like
 * any other JS change). `RelativeTimeFormat` needs `PluralRules`, which needs
 * `Intl.Locale` and `getCanonicalLocales`, so the four are polyfilled in
 * dependency order. Each `/polyfill` entry installs only when the feature is
 * absent, and each locale-data file no-ops unless its polyfill actually took —
 * so on an iOS/Hermes build that already has these, this whole module is inert.
 *
 * Locale data is loaded for exactly the app's four languages (en/hi/ta/ar);
 * pulling every CLDR locale would bloat the bundle for languages the app cannot
 * display anyway. Imported for its side effects, before the first component
 * renders — the root layout imports this at the very top.
 */

// Prerequisites, in dependency order. `getCanonicalLocales` underpins `Locale`,
// which underpins `PluralRules`, which `RelativeTimeFormat` needs for its counts.
import '@formatjs/intl-getcanonicallocales/polyfill';
import '@formatjs/intl-locale/polyfill';

import '@formatjs/intl-pluralrules/polyfill';
import '@formatjs/intl-pluralrules/locale-data/en';
import '@formatjs/intl-pluralrules/locale-data/hi';
import '@formatjs/intl-pluralrules/locale-data/ta';
import '@formatjs/intl-pluralrules/locale-data/ar';

import '@formatjs/intl-relativetimeformat/polyfill';
import '@formatjs/intl-relativetimeformat/locale-data/en';
import '@formatjs/intl-relativetimeformat/locale-data/hi';
import '@formatjs/intl-relativetimeformat/locale-data/ta';
import '@formatjs/intl-relativetimeformat/locale-data/ar';
