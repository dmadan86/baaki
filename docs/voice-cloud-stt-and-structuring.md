# Voice — cloud STT + managed LLM structuring (design)

**Status:** Proposed (design review before build)
**Feature id:** A48 (proposed)
**Author:** design draft for review
**Supersedes/extends:** the existing on-device voice quick-add ([`apps/mobile/src/app/voice.tsx`](../apps/mobile/src/app/voice.tsx), [`voiceExpense.ts`](../apps/mobile/src/lib/voiceExpense.ts), [`voiceLlm.ts`](../apps/mobile/src/lib/voiceLlm.ts), [`dictation.ts`](../apps/mobile/src/lib/dictation.ts))

---

## 1. What we are building

Two upgrades to "speak an expense", both **configurable** and both with a **graceful
fallback** to what exists today:

1. **Cloud speech-to-text (STT)** as a higher-quality tier over the on-device
   recogniser. Metered for free users (a monthly allowance of talk-time),
   unlimited for paid users, and **falling back to the on-device recogniser**
   whenever cloud STT is unavailable (offline, quota spent, provider disabled).

2. **Managed LLM structuring**: after we have text, an admin-configured LLM turns
   it into a **versioned structured expense payload** — so the parsing quality no
   longer depends on the reader bringing their own key, and future app versions
   can rely on a stable, versioned contract.

### Locked decisions (from product review)

| Question             | Decision                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------- |
| First STT provider   | **Deepgram**, behind a provider-agnostic seam (Gemini/others addable by config)             |
| Free STT quota reset | **Per calendar month** (amount set by an admin/API-tunable knob)                            |
| LLM structuring      | **Managed, admin-configured** model + versioned output; **BYOK stays an optional override** |
| Entitlement scope    | **Per person, never per group** — unlike the group "full mode" rule                         |
| Rollout              | Design doc first (this), then phased build                                                  |

---

## 2. Entitlement — per person, not per group

This is the one rule that departs from every other paid gate in the app. Today,
[`waves_group_is_paid`](../packages/db) makes a whole group "full mode" if **any**
member is subscribed (group photo, receipt cap, attachment cap all use it). Voice
STT is **the person's own capability** and must **not** leak across a group.

- Reuse the existing definer helper **`waves_profile_is_paid(p_profile uuid) →
boolean`**: true iff that profile has an `active` subscription (or an unexpired
  pass **owned by that profile**, not a group pass). Deliberately independent of
  `waves_group_is_paid`.
- A paid person gets **unlimited** cloud STT. A free person is metered.
- Group membership is irrelevant. A free user in a group with a paid member is
  **still metered** — the paid member's benefit does not extend to them.

```
access(profile) =
  waves_profile_is_paid(profile) ? 'unlimited'
  : remaining_free_seconds(profile) > 0 ? 'metered'
  : 'exhausted'   // → on-device fallback
```

---

## 3. Metering & configuration

### 3.1 Config knobs (admin + API tunable)

Reuse the existing `app_config` numeric-knob table for integers; add a small
**text** config surface for provider/model names (which `app_config.value int`
cannot hold).

| Key                          | Type | Where                  | Meaning                                     | Default          |
| ---------------------------- | ---- | ---------------------- | ------------------------------------------- | ---------------- |
| `voice_stt_free_seconds`     | int  | `app_config`           | Free talk-time per month, in seconds        | `300` (5 min)    |
| `voice_stt_max_clip_seconds` | int  | `app_config`           | Hard cap on a single request's audio length | `60`             |
| `voice_stt_enabled`          | flag | `feature_flags`        | Master on/off for cloud STT                 | off              |
| `voice_llm_enabled`          | flag | `feature_flags`        | Master on/off for managed LLM structuring   | off              |
| `voice_stt_provider`         | text | `service_config` (new) | `deepgram` \| `gemini`                      | `deepgram`       |
| `voice_stt_model`            | text | `service_config`       | Provider model id (e.g. `nova-2`)           | provider default |
| `voice_llm_provider`         | text | `service_config`       | Managed structuring provider                | (chosen)         |
| `voice_llm_model`            | text | `service_config`       | Managed structuring model                   | (chosen)         |
| `voice_llm_schema_version`   | int  | `app_config`           | Output contract version the server emits    | `1`              |

**New `service_config` table** (text knobs — `app_config` is int-only):
`key text primary key, value text, description text, updated_at timestamptz`.
Same trust shape as `app_config`/`feature_flags`: anon/authenticated **SELECT**
(non-secret names only), **service-role write**. Secrets (Deepgram key, LLM key)
live in **edge-function env**, never in a readable table.

The admin **Limits/Config** page (`apps/admin/src/app/config/page.tsx`) gains the
new numeric knobs; a sibling page edits the `service_config` text knobs. "Through
an API" = the same service-role RPC the admin console calls, callable by an
integration.

### 3.2 Usage table

```
voice_stt_usage (
  profile_id  uuid    not null references profiles(id),
  period      text    not null,          -- 'YYYY-MM' calendar month
  seconds     integer not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (profile_id, period)
)
```

- RLS: a person may **SELECT own** rows (to show "3:20 of 5:00 used"); **writes are
  service-role only** (the edge function), so usage cannot be forged from a client.
- `remaining_free_seconds(profile)` = `max(0, voice_stt_free_seconds - seconds_this_month)`.
- Monthly reset is implicit: a new `period` key ⇒ a fresh row ⇒ full allowance. No
  cron needed.

---

## 4. The STT edge function (`voice-stt`)

A metered proxy so **the device never holds the provider key** and every second is
counted server-side.

### 4.1 Contract (v1)

`POST /functions/v1/voice-stt` (authenticated; user JWT)

Request (multipart or base64 JSON):

```
{ "audio": "<base64>", "mimeType": "audio/m4a", "durationSeconds": 7.2,
  "language": "en" | "ta" | "hi" | "ar" }
```

Response:

```
{ "transcript": "three thousand rupees for petrol",
  "provider": "deepgram", "billedSeconds": 8,
  "remainingFreeSeconds": 292 | null }   // null = unlimited (paid)
```

Refusals (so the client can fall back cleanly, never a raw error):

```
409 { "code": "STT_QUOTA_EXHAUSTED", "remainingFreeSeconds": 0 }
403 { "code": "STT_DISABLED" }              // flag off / no provider configured
413 { "code": "STT_CLIP_TOO_LONG", "maxSeconds": 60 }
```

### 4.2 Server flow (all inside the function, single trust boundary)

1. Resolve the caller's profile from the JWT.
2. If `!voice_stt_enabled` → `STT_DISABLED`.
3. `paid = waves_profile_is_paid(profile)`.
4. **Derive the duration server-side.** Decode the uploaded audio and read its
   real length; the client's `durationSeconds` is a hint only and is never
   trusted for admission (a client could send full audio with
   `durationSeconds: 0` and slip past the check). Reject a non-finite or
   non-positive duration. Enforce `voice_stt_max_clip_seconds` against the
   decoded length → `STT_CLIP_TOO_LONG`.
5. **If not paid, reserve atomically before the provider call.** A single
   conditional statement adds `ceil(decodedSeconds)` to this month's usage _only
   if_ it stays within `voice_stt_free_seconds`, and reports whether it
   succeeded — so two concurrent requests cannot both pass on the same balance
   (e.g. two 200 s clips against 300 s remaining). If the reservation fails →
   `STT_QUOTA_EXHAUSTED` (client falls back to on-device; **no charge**). The
   request carries an **idempotency key**, so a replay reserves once, not twice.
6. Call the **provider adapter** (`deepgram` first) with the server-side key and
   `voice_stt_model`.
7. **Reconcile the reservation.** On provider failure, **release** the reserved
   seconds (delete/subtract under the same idempotency key) and surface a clean
   refusal. On success, reconcile the reservation to the **provider-reported**
   `billedSeconds` (the meter of record) rather than the decoded estimate. Paid
   users skip both reserve and reconcile — they are **never** metered.
8. Return the transcript + `remainingFreeSeconds`.

**Metering integrity:** admission is gated on a **server-decoded** duration, and
the final charge is the **provider-reported** seconds — the client's claimed
`durationSeconds` is trusted for neither, so it cannot be under-reported to
stretch the free tier. Reservation-before-call plus an idempotency key makes
concurrent and replayed requests safe; the clip cap bounds a single abusive
request before the provider is ever called.

### 4.3 Provider seam

```ts
interface SttProvider {
  transcribe(
    audio: Uint8Array,
    opts: {
      mimeType: string;
      language: string;
      model: string;
    },
  ): Promise<{ transcript: string; billedSeconds: number }>;
}
```

`deepgram` implemented first (per-minute billing maps straight to `billedSeconds`).
`gemini` addable later; because Gemini bills per token, its adapter derives
`billedSeconds` from the audio length it was given, keeping the meter uniform.
Which adapter runs is read from `voice_stt_provider` at request time.

---

## 5. Managed LLM structuring (`voice-structure` edge function)

Separate function so STT and structuring scale and fail independently, and either
can be turned off alone — STT by `voice_stt_enabled`, structuring by its own
`voice_llm_enabled` flag. When `voice_llm_enabled` is off (or no
`voice_llm_provider` is configured) the function returns `STRUCTURE_UNAVAILABLE`
and the client falls back to the on-device heuristic parser, exactly as it does
on a provider error.

`POST /functions/v1/voice-structure` (authenticated)

```
{ "transcript": "...", "groups": [{id,name}], "locale": "en",
  "defaultCurrency": "INR" }
```

- Reads `voice_llm_provider` / `voice_llm_model` / `voice_llm_schema_version` from
  config; calls the model with the **server-side** key.
- Returns a **versioned** payload (see §6). On any failure returns
  `{ "code": "STRUCTURE_UNAVAILABLE" }` so the client falls back to the on-device
  heuristic parser ([`parseVoiceExpenses`](../apps/mobile/src/lib/voiceExpense.ts)).
- **BYOK override:** if the reader has a personal key configured
  ([`aiKeys.ts`](../apps/mobile/src/lib/aiKeys.ts)/[`voiceLlm.ts`](../apps/mobile/src/lib/voiceLlm.ts)),
  the client may prefer the BYOK path (their key, their model) and skip the managed
  call — a per-user choice, unchanged from today.

Access to the managed LLM follows the **same per-person entitlement** as STT unless
you decide otherwise — recorded as an open question (§9).

---

## 6. Versioned output contract

The structured result is **versioned** so a newer server can enrich the payload
without breaking an older app, and a newer app can require a minimum version.

```jsonc
{
  "schemaVersion": 1,
  "items": [
    { "amountMinor": "300000", "currency": "INR",
      "description": "petrol", "category": null,
      "confidence": 0.94 }
  ],
  "group": { "kind": "existing", "groupId": "..." } | { "kind": "create", "name": "Goa" } | null,
  "splitCount": null,
  "provider": "…", "model": "…"
}
```

Rules:

- `schemaVersion` is **mandatory** and monotonic. v2+ may **add** optional fields;
  it may **never** repurpose or remove a v1 field.
- The client keeps a `MIN_SUPPORTED / MAX_SUPPORTED` window. A payload above the
  window → treat unknown fields as absent (forward-compatible). Below the window →
  fall back to the heuristic parser.
- `amountMinor` is a **string** (bigint-safe, ADR-003), scaled to the currency's
  real exponent server-side — no float ever crosses the wire.
- Every amount still passes the client's existing sanity checks before it prefills
  the review screen; a model is never trusted blindly (matches today's stance).

---

## 7. Client flow (three tiers, one review screen)

```
speak → record audio
      │
      ├─ online & cloud STT allowed?  → voice-stt  → transcript
      │        (quota / paid / flag)      │ refusal → fall through
      └─ else                            → on-device dictation.ts (basic)
                                            │
transcript → structure:
      ├─ managed allowed?  → voice-structure → versioned payload
      ├─ BYOK key set?     → voiceLlm.ts (user's key)
      └─ else              → parseVoiceExpenses (heuristic, always works offline)
                                            │
                                    editable review (voice.tsx) → save
```

- The **review screen is unchanged** — every tier feeds the same editable drafts,
  so quality improves without a new surface.
- Fallbacks are **silent and automatic**; the only user-visible signal is an
  optional "X:XX of 5:00 free voice left this month" line for free users.
- Offline is a first-class path: no network ⇒ on-device STT + heuristic parser,
  exactly today's behaviour. The feature never blocks the core action.

---

## 8. Phasing

- **Phase 1 — entitlement & config plumbing (no external calls).** Reuse
  `waves_profile_is_paid`; `voice_stt_usage`, `service_config`, the `app_config`
  knobs, `waves_voice_stt_remaining_seconds`, `waves_voice_stt_record`
  (service-role), and the client-facing `waves_my_voice_access`. On the client:
  the `useVoiceAccess` hook that reads it and the pure `pickVoiceMode(access,
{online, cloudEnabled})` selector — both land here so the tier decision is
  unit-tested before any network tier exists. Fully testable with DB + unit
  tests; ships dark (`feature_flags:voice_stt_enabled` off, no provider keys, and
  no caller invokes the cloud tier yet).
- **Phase 2 — `voice-stt` edge function + Deepgram adapter + wiring it in**
  (metered proxy, fallback): the client starts _calling_ `voice-stt` and routing
  on the `pickVoiceMode` decision that shipped in Phase 1. Needs the Deepgram key
  in edge env.
- **Phase 3 — `voice-structure` edge function + managed LLM + versioned contract.**
  Needs the LLM key in edge env.
- **Phase 4 — usage surfacing** ("free voice left"), admin dashboards, and a
  second STT provider adapter (Gemini) to prove the seam.

Each phase is its own PR; Phases 2–3 are **deploy-gated** on the provider keys.

---

## 9. Open questions (decide before Phase 2/3)

1. **Managed LLM entitlement** — same per-person paid/metered rule as STT, or free
   for everyone within their STT quota, or paid-only? (Cost driver.)
2. **Whose key pays** — a single platform Deepgram/LLM account (we absorb cost,
   the usual SaaS model), confirmed? Any per-tenant key story for enterprise?
3. **Audio retention** — do we keep the uploaded audio at all? Proposed: **no**
   server-side retention; transcribe and discard, log only seconds + provider.
4. **Language coverage** — Deepgram model per language (en/ta/hi/ar); confirm the
   model ids and that all four are supported at acceptable quality, else fall back
   to on-device for the unsupported language.
5. **Abuse / rate limits** — beyond the monthly quota, a per-minute request cap on
   `voice-stt` (reuse `_shared/rateLimit.ts`).

---

## 10. Security & cost notes

- Provider keys live **only in edge-function env**; the device and every readable
  table are keyless (same posture as `r2-sign`).
- Metering is **server-authoritative** (provider-reported seconds), so the free
  tier cannot be stretched from the client.
- No audio retention (proposed) keeps this out of the privacy blast radius; only
  derived counts persist.
- Hard caps (`max_clip_seconds`, monthly quota, optional rate limit) bound spend
  before any provider bill.

---

## 11. Spec amendments required

- **ADR:** a new ADR for "per-person paid capabilities" — the first gate that is
  **not** group-inherited, to sit beside the group "full mode" rule.
- **ADR-002 addendum:** two new edge functions (`voice-stt`, `voice-structure`)
  and the `service_config` text-knob table.
- **TDR:** the versioned voice output contract (§6) as a stable, documented
  interface; the metering table and reset semantics.
- Note the existing SMS/voice/receipt deviations already tracked, so this joins
  them rather than duplicating.
