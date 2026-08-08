# Baaki

**பாக்கி — "balance / what's still owed".** An expense-splitting app for India:
unlimited free ledger, link-based guest joining, UPI-native settlement with
partial and per-expense payments, and free AI receipt itemization.

The two binding specs live in this repo: [`baaki-adr.md`](./baaki-adr.md) (14
accepted architecture decisions) and [`baaki-tdr.md`](./baaki-tdr.md) (how to
build them, milestone by milestone). **The ADRs are constraints, not
suggestions** — if code and ADR disagree, the ADR wins.

Current state: **M0 and M1 complete and verified against a live Supabase
project**, plus most of the M3 growth loop (invite links, joining without an
account, ghost claiming) and the M5 export. Still to come: offline sync (M2),
Splitwise import (M3), push/email delivery (M4), and the AI receipt scan (M5).

## Layout

```
apps/mobile/       Expo (SDK 57, React 19, Expo Router, TypeScript strict)
packages/core/     Pure money/split/balance/simplify/settlement logic — no deps
packages/db/       Prisma schema + migrations (RLS, triggers, derived balances)
packages/ui/       Design tokens and components
supabase/          Local stack config + edge functions (M2+)
e2e/               Maestro flows
```

`packages/core` has **zero runtime dependencies** on React or Supabase. That is
deliberate: the app, the guest web view and the Deno edge functions all import
the same module, so three runtimes can never disagree about what someone owes.

## Getting started

```bash
pnpm install

# money engine: 51 tests, property-based
pnpm test:core

# database: throwaway Postgres, migrations, RLS + invariant tests
pnpm db:pg:up
cp .env.example packages/db/.env      # defaults already point at the container
pnpm db:migrate
pnpm test:db
```

Requires Node 24+, pnpm 11+, and Docker.

### Screens

Sign in (phone OTP or guest) · Home · Activity · Friends · Account · New group ·
Group (expenses / balances / activity) · Expense detail with version history ·
Add or edit expense · Split by item · Spending · Settle up · Who pays whom ·
Members · Member detail · Group settings · Invite · Join from a link ·
Notification preferences · Security (app lock, re-ask delay, sign out) ·
Inbox · Export · Import.

### Scheduled jobs

Both run hourly under `pg_cron`, take their clock as an argument so they can be
tested without waiting a week, and are idempotent — `notifications.dedupe_key`
is what makes a retried run a no-op rather than a second buzz.

| Job                                | What it resolves                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `baaki_auto_confirm_settlements()` | A settlement nobody answered for 7 days (ADR-007). A dispute still reopens it.                                                                                                                               |
| `baaki_claim_push_notifications()` | Hands unsent inbox rows to the fanout. An UPDATE, not a SELECT — two overlapping runs cannot both send the same reminder.                                                                                    |
| `baaki_trip_nudges()`              | Twice a day during a group's dates: at breakfast about yesterday, at the end of the day about today. Skips anybody who already recorded that day, and asks in the group's timezone rather than the server's. |

### Edge functions

| Function        | What it owns                                                                |
| --------------- | --------------------------------------------------------------------------- |
| `expense-write` | Recomputes every share with `@baaki/core` and writes the expense atomically |
| `invite-mint`   | Signed, expiring, revocable invite links (only a hash is stored)            |
| `invite-accept` | Preview without an account, join, and ghost claiming                        |
| `export-data`   | Lossless JSON and CSV export                                                |
| `notify-fanout` | Claims unsent inbox rows and pushes them via Expo; revokes dead devices     |

### Running the full stack

The app talks to Supabase, so it needs the local stack rather than the bare
Postgres container above:

```bash
pnpm supabase:start                  # Postgres + Auth + PostgREST + Realtime + Edge runtime
pnpm db:migrate                      # point DIRECT_URL at the stack's db port first (54322)
pnpm edge:build                      # bundles @baaki/core for the Deno runtime
pnpm edge:serve                      # serves supabase/functions locally

# apps/mobile/.env — take the values printed by `supabase start`
#   EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
#   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon key>
pnpm mobile
```

`supabase start` pulls ~10 container images the first time; on a slow or
proxied network that can take a while. To work against a hosted project
instead, point `packages/db/.env` at it and deploy the functions with
`pnpm edge:deploy`.

### Acceptance runs

These talk to a real Supabase project and are the reason M1 is called done:

```bash
ANON_KEY=... SERVICE_KEY=... node e2e/m1-acceptance.mjs   # 26 checks
ANON_KEY=... SERVICE_KEY=... node e2e/m3-invites.mjs      # 20 checks
```

## The invariants

These are the product promise, so they are tests, and CI blocks a merge if any
of them break:

| Invariant                                              | Where                                          |
| ------------------------------------------------------ | ---------------------------------------------- |
| Σ shares === expense total, for every split type       | `packages/core/test/split.property.test.ts`    |
| Σ balances === 0, per group per currency               | `packages/core/test/balances.property.test.ts` |
| Simplification never changes anyone's net position     | `packages/core/test/simplify.property.test.ts` |
| FX conversions are exactly reproducible                | `packages/core/test/money.test.ts`             |
| Stored balances === the ground-truth aggregate         | `packages/db/test/invariants.test.ts`          |
| Non-members can read nothing; guests only their group  | `packages/db/test/rls.test.ts`                 |
| Expense history cannot be rewritten or hard-deleted    | `packages/db/test/invariants.test.ts`          |
| Only a group member can create, delete or settle in it | `packages/db/test/m1-rpcs.test.ts`             |
| Only the payee can confirm a settlement                | `packages/db/test/m1-rpcs.test.ts`             |
| Replaying a mutation id never double-posts             | `packages/db/test/m1-rpcs.test.ts`             |
| A crash report carries no ledger                       | `apps/web-lite/test/reporting.test.ts`         |

The client also recomputes each group's balances with `@baaki/core` and compares
them against the server's `group_balances`. If they ever disagree, the group
screen says so rather than showing a number that might be wrong.

## Crash reporting

Sentry, on all three surfaces — the app, the guest web view and the edge
functions. TDR §11 asks for crash-free sessions above 99.5%, and a 500 from an
edge function is otherwise a line in a log nobody reads.

Everything reported goes through `scrub` in
`packages/core/src/observability/scrub.ts` first. One policy, shared by all
three, because a crash report from an expense splitter would otherwise carry
who ate with whom, the number they were invited on, and the handle they pay
from. What survives is the diagnosis: amounts, ids, stack frames, and the
platform it happened on.

It has a limit and the limit is written down: the scrubber catches shapes
(emails, numbers, UPI handles, tokens) and known fields. A bare name under a key
nobody anticipated matches nothing. So the rule for anything that reports an
error is **attach ids, never rows**.

Nothing is reported unless a DSN is set, so a clone with no Sentry account
builds and runs unchanged:

| Variable                        | Where                      | What it does                                     |
| ------------------------------- | -------------------------- | ------------------------------------------------ |
| `EXPO_PUBLIC_SENTRY_DSN`        | `apps/mobile/.env`         | turns reporting on in the app                    |
| `NEXT_PUBLIC_SENTRY_DSN`        | `apps/web-lite/.env.local` | same, for the guest view                         |
| `SENTRY_DSN`                    | edge function env          | same, for the functions                          |
| `SENTRY_ORG` / `SENTRY_PROJECT` | build env                  | adds source-map upload; without them, minified   |
| `SENTRY_AUTH_TOKEN`             | build env only             | write token — never in a bundle, never committed |

A DSN is public by design: it can only write events, which is why it ships in
the binary. `SENTRY_AUTH_TOKEN` is the one that reads, and it stays in CI.

## Saying the note instead of typing it

The mic beside "What was it for?" is the platform's own recogniser —
`SFSpeechRecognizer` on iOS, `SpeechRecognizer` on Android, via
`expo-speech-recognition`. On-device whenever the phone has a model for the
language, so what somebody says across a restaurant table is not sent anywhere;
where it has none, the OS falls back to the same network recogniser its own
keyboard mic uses.

Three decisions worth knowing:

- **It recognises in the language the app is showing**, and keeps the phone's
  own region when the two agree — `en-GB` stays `en-GB`, a bare `ta` becomes
  `ta-IN`. `speechLocale` in `apps/mobile/src/lib/dictation.ts`.
- **Member names are passed as `contextualStrings`.** A general model guesses at
  Indian names and gets them wrong, and the note is where they turn up.
- **Dictation adds to the field, never replaces it.** Interim results arrive in
  full each time, so the text is recomputed from what was there when the mic was
  tapped rather than appended — `mergeTranscript`, and the test that pins it.

Native module, so it needs a new dev build or store build: `npx expo prebuild`
then `eas build`. The mic does not render on web, and an existing binary will
not grow it from an over-the-air change.

That last point cost an app launch once. `requireNativeModule` throws at the
top of the module's own file, and expo-router loads every route file to build
the route tree — so on a binary that predates the module, the throw is not a
missing microphone, it is a red screen at launch naming a screen nobody had
opened. The import therefore lives in `DictateVoice.tsx` and is reached from
`DictateButton.tsx` through a `require` inside a `try`. **Any native module
added from here on wants the same treatment**, unless every binary that will
ever run the bundle is guaranteed to contain it.

## Scanning the bill instead of typing it

The camera on the add-expense screen is the platform's document scanner —
`VNDocumentCameraViewController` on iOS, ML Kit's document scanner on Android,
via `react-native-document-scanner-plugin`. It finds the page edges and
corrects the perspective, which matters more than it sounds: what follows is
OCR, and OCR reads characters without knowing which ones are on the receipt. A
flat crop of the bill is a different proposition from a photograph of a table.

Capture is one function, `captureReceipt` in `apps/mobile/src/lib/image.ts`,
used by both the add-expense screen and Split by item. It falls back to the
plain camera on a build with no scanner, so the screen asking for a receipt
never has to know which one it got.

What a scan does depends on where it was started:

- **Add expense** takes the grand total and the merchant's name, and leaves the
  splitting alone. Most bills are split some way that has nothing to do with
  what each line cost, and dropping somebody into claiming items because they
  photographed a bill would be worse than letting them type a total.
- **Split by item** fills the lines, as it always has.

A scan started on one and finished on the other is not re-taken. The parsed
receipt is handed over through the draft store — `apps/mobile/src/lib/handover.ts`
— keyed per group, consumed once, cleared immediately, and ignored after ten
minutes. A scan costs the group one of its free scans (ADR-011), so asking for
the same bill twice is a real cost; a receipt left lying in the store to
pre-fill somebody's screen days later is a real bug.

Native module, so it needs `npx expo prebuild` and a new build, and it gets the
lazy-require treatment described above — `TurboModuleRegistry.get` answers
"is it in this binary" without throwing, and the package is only required once
the answer is yes.

### Building it natively

```bash
cd apps/mobile
npx expo prebuild --platform android    # ios needs macOS; Expo refuses on Windows
cd android && ./gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a
```

Needs JDK 17, and an Android SDK with `platform-tools`, `platforms;android-36`
and `build-tools;36.0.0`. The APK lands in
`android/app/build/outputs/apk/debug/`.

Two things in this repo exist only because of pnpm, and both fail in ways that
name a file nobody here wrote:

- **`plugins/withShortNativeBuildPath.js`** moves the CMake staging directory to
  `C:\cxx\<module>` on Windows. Five dependencies compile C++, and CMake refuses
  an object path over 250 characters — pnpm's store spends 192 of them before
  the object is named. What you see is not a path error: ninja regenerates its
  manifest in a loop and dies with `manifest 'build.ninja' still dirty after 100
tries`, ten minutes in, blaming `react-native-screens`. Windows long paths do
  not help; the limit is CMake's.
- **`packageExtensions`** in `pnpm-workspace.yaml` declares
  `@expo/config-plugins` for `react-native-document-scanner-plugin`, whose
  config plugin requires it without depending on it. Always present under npm's
  flat layout; absent under pnpm's, where the build dies in
  `expo-constants:createExpoConfig`.

## Where the money went

The Spending screen (`group/[id]/insights`) draws two charts over
`baaki_group_spending(group_id)` — what each category cost, and month by month,
for the whole group or for you alone. The function returns the finest grain it
can (member × category × month × currency) and the screen adds up whichever way
it is being asked; summing server-side would answer only one of the two
questions.

Three things it will not do, all of them inherited from the ledger:

- **No currency conversion.** An expense carries the rate that was used
  (ADR-003). Multiplying it out for a chart would print a rounded,
  unreproducible number next to exact ones, so each currency gets its own
  section.
- **No re-dividing.** The per-person figures are the shares the ledger stored,
  odd paisa and all.
- **No history.** Only the current version of a live expense counts, the same
  rule the balances use.

The category comes from a guess, not a menu: `guessCategory` in
`packages/core/src/category` matches whole tokens against an India-first keyword
table — auto, chai, Swiggy, Zepto, IRCTC, kirana — and the chip it picks can be
changed with one tap. Whole tokens, never substrings: `ola` is a cab company and
also the middle of "chocolate". The guess stops the moment somebody taps a chip,
and opening an old expense never re-guesses.

The charts are plain views, not victory-native. That library renders through
Skia now, which is another native module and another prebuild, to animate a list
of bars and a row of columns.

## Taking your ledger elsewhere, and bringing it back

Export is JSON (lossless) or CSV, for one group or all of them, free forever
(ADR-012). The import screen reads three things: a Splitwise CSV, and Baaki's own
JSON export, through one RPC — `baaki_import_ledger`, of which
`baaki_import_splitwise` is now a thin wrapper.

What comes back from our own file is every balance, to the paisa, in every
currency, settlements included. What does not: ids, edit history, and settlement
allocations. None of the three changes what anybody owes, and the screen says so
in those words before the import runs. `packages/db/test/m5-import-export.test.ts`
proves the round trip against a real database rather than in the abstract.

## Turning on push

Everything between the inbox row and the phone is built and tested — the claim,
the fan-out, the language, the dead-device revocation. The one part that is not
in this repository is the credential that lets a phone have a push token at all,
because it is issued by a console and belongs to whoever owns the app.

The path is Baaki → Expo → **FCM** (Android) or **APNs** (iOS) → the phone. Expo
is a relay; the credentials at the far end are still yours to supply.

**Android, once:**

1. Create a Firebase project and add an Android app to it with the package name
   `app.baaki.mobile`. It must match, exactly — a mismatch is the error
   `MismatchSenderId` on every notification, months later.
2. Download `google-services.json` and put it at `apps/mobile/google-services.json`.
   It is gitignored: this repository is public, and the file names the Firebase
   project builds get pointed at.
3. Give the same file to EAS, so cloud builds have it too:

   ```bash
   eas env:create --name GOOGLE_SERVICES_JSON --type file \
     --value ./apps/mobile/google-services.json --scope project
   ```

4. In the Firebase console, under **Project settings → Service accounts**,
   generate a new private key, then hand it to Expo — this is what lets Expo's
   servers send on your behalf:

   ```bash
   eas credentials   # Android → production → Google Service Account → Push Notifications
   ```

5. Rebuild. The credential is compiled in; an existing build will not pick it up.

`apps/mobile/app.config.ts` finds the file from the EAS secret or the local copy,
and **leaves the key off entirely when there is neither** — so a checkout without
a Firebase account still builds and runs. What does not work then is registering
for push, and the notifications screen says so in those words rather than sending
somebody to their phone settings over a problem that is ours.

**iOS** needs an APNs key uploaded the same way (`eas credentials` → iOS → Push
Notifications), which needs a paid Apple Developer account and a Mac. Not done.

**When it is set up and still silent**, read the fanout's reply before suspecting
the phones. It reports `problems` by Expo's error code, and `misconfigured: true`
when those codes are `MismatchSenderId` or `InvalidCredentials` — the two that
mean the credentials are wrong rather than the devices. Without that, a wrong key
looks exactly like a country with its phones switched off: rows go out, failures
climb, and nothing anywhere names the cause.

## Turning on Sign in with Apple

Like push, the code is here and the credential is not: Apple issues it to whoever
owns the app. Unlike push, **two** things have to be configured, because Baaki
reaches Apple by two different roads and they authenticate differently.

The two roads, and why there are two:

| Who is tapping                                                               | Road                                              | Needs                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------- |
| Nobody signed in, on an iPhone                                               | native sheet → `signInWithIdToken`                | the **bundle ID**       |
| Everybody else — Android, and **any** guest or existing account adding Apple | web redirect → `linkIdentity` / `signInWithOAuth` | a **Services ID** + key |

The second row is the common one, not the fallback. ADR-006 puts everybody
through the guest door first, so most people who ever tap Apple are linking it to
an account they already have — and `signInWithIdToken` has no way to add a
provider to an existing session. Configure only the native side and Apple works
for a fresh install and silently fails for everyone the app is actually built
around.

**In the Apple Developer console, once:**

1. Enable the **Sign in with Apple** capability on the App ID `app.baaki.mobile`.
2. Create a **Services ID** (a separate identifier — this is the web client), and
   set its return URL to
   `https://xvjzbpgcmotoahtqcxve.supabase.co/auth/v1/callback`.
3. Create a **Sign in with Apple key**, and keep the `.p8` — it is downloadable
   exactly once.

**In the Supabase dashboard**, under Authentication → Providers → Apple: enable
it, put **both** identifiers in Client IDs as a comma-separated pair
(`app.baaki.mobile,<the Services ID>`), and paste the Team ID, Key ID and `.p8`.
Both roads then land on the same account, which is the point of listing both.

All of this needs a paid Apple Developer account. Without it, `withApple` in
`lib/auth.tsx` still compiles and the button still renders — it is Supabase that
refuses, and the screen shows what it said.

**What is safe to skip:** nothing about a device or a build. `expo-apple-authentication`
resolves its functions through `requireOptionalNativeModule`, and
`lib/appleAuth.ts` reads Expo's registry before requiring the package at all, so
an Android phone or an iOS build made before this package existed shows the plain
fallback button rather than failing to launch. `usesAppleSignIn` in `app.json` is
what writes the entitlement into the binary, so turning this on **needs a
rebuild** — an existing build has no capability to use.

## Releasing, and stopping old builds

The version is compiled into the binary, so a build can only ever describe
itself — it cannot know something newer exists. The policy lives in
`public.app_releases`, one row per store, and the app asks on launch and on
every foreground.

| Column            | Means                                          |
| ----------------- | ---------------------------------------------- |
| `latest_version`  | what is published — a dismissible banner       |
| `minimum_version` | the oldest build allowed to open — a hard wall |
| `store_url`       | where the Update button goes                   |
| `message`         | optional, replaces the default wall copy       |

Raising them is one statement, and it takes effect on the next foreground with
no app release involved:

```sql
-- a new build is out; nothing is wrong with the old one
UPDATE app_releases SET latest_version = '0.2.0' WHERE platform = 'android';

-- 0.1.x may no longer run: it computed something wrongly
UPDATE app_releases
   SET minimum_version = '0.2.0',
       message = 'Expenses added on the old version split rupees wrongly.'
 WHERE platform = 'android';
```

Only the service role can write it; everybody, including signed-out guests, can
read it, because the check runs before the sign-in screen.

Three things stop a mistake here from bricking every phone:

- A `CHECK` refuses a `minimum_version` above `latest_version` — that row would
  block every build in existence, including the one the Update button installs.
- A `CHECK` refuses a version string the client cannot compare (`v2`, `2.0-rc`),
  which would otherwise silently switch the policy off.
- The client fails towards opening: no answer, an unreadable version, or a
  policy it does not understand all resolve to "carry on". The one exception is
  a policy it has already fetched, which is cached and honoured offline —
  "this build computes money wrongly" does not stop being true when the phone
  loses signal. Every foreground re-checks, so a corrected policy lands as soon
  as there is a connection.

The comparison itself is `compareVersions` in `packages/core/src/version`,
mirrored in SQL by `baaki_version_key()` so the database and the app cannot
disagree about which of two versions is newer.

## Money rules

- Amounts are **`BIGINT` minor units** plus an ISO-4217 code. No float, no
  decimal, anywhere (ADR-003).
- Balances are **always derived**, never stored as a mutable running total
  (ADR-004). The Postgres tables are a cache that CI proves equal to the
  aggregate.
- The remainder of an uneven split rotates by expense id, so the same person
  does not always absorb the extra paisa (ADR-009).
- Baaki **never moves money**. Settlement opens a UPI intent in the payer's own
  app and records the outcome (ADR-007).

## Monetization guardrail (ADR-011)

Manual expense entry, groups, all split types, balances, settlement recording
and export are **unlimited and free, forever**. No daily caps, no ads in a money
flow. Convenience is what gets monetized: AI scan volume beyond the free quota,
deeper analytics, trip passes, themes. Treat this as a review checklist item.
