# Waves — marketing site

The public site at **wavs.co.in**. A separate deployment from the product: this
one is static, has no database, no auth and no `@waves/*` imports, so it can be
rebuilt and redeployed without touching the app.

```
src/app/[locale]/        every page, one per language
src/app/[locale]/privacy Privacy policy
src/app/[locale]/terms   Terms
src/components/          sections, drawn product visuals, primitives
src/i18n/                locale config + one dictionary per language
middleware.ts            bare paths get a locale prefix
```

## Running it

```bash
pnpm install
pnpm website          # from the repo root
# or, in this directory
pnpm dev
```

## Languages

`en`, `ta`, `hi`, `ar` — the same four the app speaks. Arabic reads right to
left, which on the web is one `dir="rtl"` on `<html>`; layout uses logical
properties (`ps`/`pe`, `ms`/`me`, `text-start`) so it mirrors on its own, and
the few directional icons flip through the `rtl:` variant defined in
`globals.css`.

The locale lives in the first path segment rather than a cookie, so a link
shared in Tamil opens in Tamil for whoever receives it, and every page
prerenders per language.

**English is the contract.** `Dictionary` is `typeof en`, so a key missing from
`ta.json`, `hi.json` or `ar.json` is a build error rather than a blank space on
a page nobody on the team can read. Add a key to `en.json` first, then to the
other three.

The legal pages are published in English in every locale on purpose — a
translated policy nobody has had reviewed would be worse than an honest English
one. They say so on the page.

## Design

The palette is lifted from `packages/ui/src/tokens.ts` so the site and the app
are recognisably the same product: the indigo/violet brand ramp, the sunset
coral accent, the night canvas, and the blue/red money pair used only where it
means money. No green anywhere.

The product illustrations are **drawn, not screenshotted** — a screenshot cannot
be translated, goes stale the week the UI moves, and ships a 400 KB PNG.

## Deploying

Vercel, as its own project, with **Root Directory** set to `website`.

| Setting           | Value                          |
| ----------------- | ------------------------------ |
| Project name      | `waves`                        |
| Framework         | Next.js (detected)             |
| Root directory    | `website`                      |
| Install command   | `pnpm install`                 |
| Build command     | `pnpm build`                   |
| Production domain | `wavs.co.in`, `www.wavs.co.in` |

Nothing deploys on a push: `git.deploymentEnabled` is false, and the only way a
deployment happens is the **Vercel deploy (manual)** workflow in the Actions tab
— pick `website` and a target. It needs `VERCEL_TOKEN`, `VERCEL_ORG_ID` and
`VERCEL_PROJECT_ID_WEBSITE` (the id in this directory's `.vercel/project.json`
after a `vercel link`) as repository secrets.

`vercel.json` carries an `ignoreCommand` so a push that did not touch this
directory does not spend a deployment — the free tier rate-limits on a burst of
commits.

### Environment variables

| Name                   | Default                  | What it is                  |
| ---------------------- | ------------------------ | --------------------------- |
| `NEXT_PUBLIC_SITE_URL` | `https://wavs.co.in`     | Canonical URLs, sitemap, OG |
| `NEXT_PUBLIC_APP_URL`  | `https://app.wavs.co.in` | Where every CTA points      |

Both have working defaults; set them only if a domain moves.

The apex question is settled: this site owns `wavs.co.in`, the product answers
on `app.wavs.co.in` and the console on `admin.wavs.co.in`. The mobile app's
invite links and the button in every email resolve against `app.wavs.co.in`,
so nothing here should be pointed back at the apex.
