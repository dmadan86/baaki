-- The Android bank-SMS inbox reader, behind a flag.
--
-- Reading the inbox needs the Play-restricted READ_SMS permission and a native
-- reader that only exists in a prebuilt binary. Both ship dormant: the screen
-- is paste-only until this flag is switched on, so the capability can be rolled
-- out to a cohort (or a single test account) from the console without another
-- store release, and turned off again the same way.
--
-- Seeded disabled with a zero rollout. `enabled` plus `rollout_percent` are the
-- two dials the console turns; the app reads the same answer through
-- `baaki_variant` / @baaki/core so an offline phone gates identically. Off is
-- the fallback everywhere, so a phone that cannot read this row shows paste,
-- which is exactly the safe default (see the feature_flags migration).
--
-- ON CONFLICT so re-running the migration never clobbers a rollout an operator
-- has since dialled up in production.

INSERT INTO public.feature_flags (key, description, enabled, rollout_percent)
VALUES (
  'sms_inbox_read',
  'Android only: read bank SMS from the inbox (READ_SMS) instead of pasting. Ships dormant; switch on to roll the native reader out to a cohort.',
  false,
  0
)
ON CONFLICT (key) DO NOTHING;
