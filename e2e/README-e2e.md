# Mobile end-to-end tests (Maestro)

The flows in this directory drive the real app on a device/emulator. They are
the only tests that exercise rendering, navigation and the offline mirror end to
end. The CI job that runs them (`e2e (Maestro)` in `.github/workflows/ci.yml`)
is **gated off by default** and turns on once the prerequisites below exist —
until then it is a clean skip, not a failure.

## What the flows expect

Each flow signs into a **known, seeded account** (`e2e/login.yaml`) and then
asserts against a **deterministic fixture** created by `e2e/seed-e2e.mjs`:

- a group named **Goa trip** (a trip, 🏖️),
- one expense **Beach shack dinner** (₹1200), paid by the ghost **Priya**,
  split among the ghosts **Priya / Sam / Dev** — so the login user's balance is
  **zero** (which is why `leave-group` can leave without settling first).

Because the fixture is fixed, the flow assertions are real (`assertVisible: 'Goa
trip'`), not `optional` "screen renders" stubs.

## Enabling it in CI

1. **Create a staging Supabase project** (never point this at production — the
   seeder refuses the prod ref and rewrites data freely). Apply the same
   migrations to it (`pnpm --filter @waves/db migrate:deploy` with its
   `DIRECT_URL`).

2. **Add the Waves Android build profile.** The flows use `appId:
app.waves.mobile`; the build needs `android/app/google-services.json`
   registered for that package (the Stage-C Firebase step). Base64 it into a
   secret.

3. **Set the repo variable and secrets** (Settings → Secrets and variables →
   Actions):

   | kind     | name                       | value                                   |
   | -------- | -------------------------- | --------------------------------------- |
   | variable | `E2E_ENABLED`              | `true`                                  |
   | secret   | `E2E_SUPABASE_URL`         | staging project URL                     |
   | secret   | `E2E_SUPABASE_ANON_KEY`    | staging anon key (baked into the build) |
   | secret   | `E2E_SERVICE_KEY`          | staging service_role key (seeder only)  |
   | secret   | `E2E_EMAIL`                | e.g. `e2e@waves.test`                   |
   | secret   | `E2E_PASSWORD`             | the login password                      |
   | secret   | `GOOGLE_SERVICES_JSON_B64` | `base64 -w0 google-services.json`       |

Once those are present, the job seeds the fixture, builds the APK against
staging, boots an API-34 emulator, installs Maestro, and runs the flows.

## Running locally

```bash
# 1. Seed a staging (or local-Supabase) project:
export E2E_SUPABASE_URL="https://<ref>.supabase.co"
export E2E_SERVICE_KEY="<service_role key>"
export E2E_EMAIL="e2e@waves.test"
export E2E_PASSWORD="<password>"
node e2e/seed-e2e.mjs

# 2. Build + install the app against the same project (see apps/mobile). Then run
#    each flow on its own, reseeding first, because the flows mutate the backend:
for flow in home-to-add-expense edit-expense delete-restore-expense \
            change-logo capture-assign locale-switch \
            rename-archive-group sign-out-privacy clone-group \
            group-photo-paid-gate friends-merge-guests leave-group; do
  node e2e/seed-e2e.mjs
  maestro test --env E2E_EMAIL="$E2E_EMAIL" --env E2E_PASSWORD="$E2E_PASSWORD" "e2e/$flow.yaml"
done
```

`login.yaml` is a sub-flow (`runFlow`) — run the flows explicitly (one per
invocation) rather than `maestro test e2e/`, so it is not executed on its own.
In CI this loop lives in `e2e/run-maestro.sh`.

## The flows

| Flow                          | Guards                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `home-to-add-expense.yaml`    | launch → balance → open group → see expense + ghost → add-expense calculator        |
| `edit-expense.yaml`           | edit the seeded expense → the ledger reflects the new value                         |
| `delete-restore-expense.yaml` | delete → gone from the default view → Show deleted → Restore → back                 |
| `rename-archive-group.yaml`   | rename a group (persists) → archive → gone from Home                                |
| `change-logo.yaml`            | open Group settings → cover-emoji picker → pick a new icon → applies, sheet closes  |
| `capture-assign.yaml`         | capture with no group → find it in the inbox → assign → add-expense prefilled       |
| `locale-switch.yaml`          | Account → Language → switch to Hindi → strings re-render live (no restart)          |
| `sign-out-privacy.yaml`       | sign out → back at the gateway, the ledger off screen                               |
| `clone-group.yaml`            | Duplicate → prefilled New Group → drop a member → Create → copy made, original kept |
| `group-photo-paid-gate.yaml`  | group photo is paid, cover emoji is free                                            |
| `friends-merge-guests.yaml`   | merge the two seeded "Reeya" ghosts, with the irreversible-warning gate             |
| `leave-group.yaml`            | leave a settled group → gone from Home and stays gone after relaunch                |

Each flow mutates the shared staging backend, so CI **reseeds the fixture before
every flow** (the seed is idempotent). Locally, run one flow at a time and
reseed between them.

The `.mjs` scripts in this directory are a separate concern: manual integration
checks against a **deployed** stack (see each file's header).
