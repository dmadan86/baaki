#!/usr/bin/env bash
# Drives the Maestro flows inside the CI emulator. This lives in a file, invoked
# as a single line from the workflow, because android-emulator-runner parses its
# inline `script:` line-by-line — a multi-line `for` loop or a persisted `export`
# in the inline block would not survive that. One `bash e2e/run-maestro.sh` runs
# as one command, so the loop and PATH behave normally.
#
# Each flow mutates the shared staging backend (archive, leave, rename, delete),
# so the deterministic fixture is reseeded before every flow. The seed is
# idempotent (reset + rebuild) and each flow's login.yaml does clearState, so no
# state leaks across. Flows run one at a time so login.yaml is never standalone.
#
# Requires in the environment: E2E_SUPABASE_URL, E2E_SERVICE_KEY, E2E_EMAIL,
# E2E_PASSWORD (the seeder + Maestro read these).
set -uo pipefail

curl -Ls "https://get.maestro.mobile.dev" | bash
export PATH="$PATH:$HOME/.maestro/bin"

adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk

FLOWS=(
  home-to-add-expense
  edit-expense
  delete-restore-expense
  rename-archive-group
  change-logo
  capture-assign
  custom-tags
  locale-switch
  sign-out-privacy
  clone-group
  group-photo-paid-gate
  friends-merge-guests
  leave-group
  widget-deeplinks
  auth-providers
  shortcut-preference
)

status=0
for flow in "${FLOWS[@]}"; do
  echo "::group::seed + ${flow}"
  node e2e/seed-e2e.mjs
  maestro test \
    --env E2E_EMAIL="${E2E_EMAIL}" \
    --env E2E_PASSWORD="${E2E_PASSWORD}" \
    "e2e/${flow}.yaml" || status=1
  echo "::endgroup::"
done

exit "${status}"
