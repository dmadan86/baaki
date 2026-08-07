# Baaki design system

Derived from the two reference boards supplied at kickoff. Both share the same
skeleton, and Baaki takes it wholesale: a lavender canvas, white cards with
generous corner radii and one soft shadow, a single saturated purple that owns
every primary action and active state, and a pastel family for tinted
category/stat cards. Navigation is a floating white pill; the active
destination expands into a filled purple pill that also shows its label.

Everything below is code, in `packages/ui/src/tokens.ts` and `theme.tsx` — this
file explains the _why_, the tokens are the source of truth.

## Colour

| Role       | Light                                                                                                 | Notes                                           |
| ---------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Brand      | `#7A5AF8` (pressed `#6C4EE3`)                                                                         | CTAs, active tab pill, FAB, selected chips      |
| Brand soft | `#E9E4FF`                                                                                             | secondary buttons, operator keys, badges        |
| Canvas     | `#F3F1FB`                                                                                             | every screen background                         |
| Surface    | `#FFFFFF`                                                                                             | cards, sheets, list containers                  |
| Text       | `#14142B` / muted `#7B7B8F` / faint `#A8A9BA`                                                         | three levels, no more                           |
| Tints      | lilac `#DCD9FB` · pink `#F8D7DA` · mint `#C7EDE4` · peach `#FBE0C4` · sky `#CFE6FA` · coral `#FFC5C5` | each with a matching ink colour for text on top |

Dark mode keeps the same hues at lower luminance (`theme.tsx`), so a group's
colour identity survives the switch.

**The brand wash** (`theme.gradient.brand`) is three stops off that same purple
ramp, dark corner to light, and it is the only gradient in the app. It is a way
of drawing the brand, not a second brand: every stop is dark enough to carry
white text, because the balance and its labels sit on all of them. `Gradient`
paints it, and falls back to flat brand if `expo-linear-gradient` is missing
from a build — a decoration may never be the reason a screen fails to render.

### The one rule that is not decorative

**Money colour is semantic and global.** Owed-to-you is always the
positive/mint pair; you-owe is always the negative/pink pair. Nothing else in
the app may use those two colours, because in a ledger app colour is data:
a user should be able to answer "am I up or down?" without reading a digit.

`MoneyText` enforces it — components pass an amount and a mode, never a colour.

It also renders the minor units fainter than the major ones (`₹1,517`**`.53`**),
in the amount's own colour rather than grey, so the fade works on the brand
panel, on green and on red alike. Where the split falls is the locale's
business, not ours: `formatParts` in `@baaki/core` cuts the string at the
separator `Intl` actually used, because `de-DE` writes `1.517,53 €` and
searching for a `.` would take the wrong one.

## Type

One family, seven steps: `display 34 · title 24 · heading 19 · subheading 16 ·
body 15 · caption 13 · micro 11`. Money always renders with tabular figures so
columns do not jitter as digits change, and money always carries a spoken label
("You are owed ₹420") rather than a bare number — TDR §11.

Dynamic type is respected up to 1.6×, capped so money rows stay legible instead
of clipping.

## Shape and depth

Radii: `sm 12 · md 16 · lg 20 · xl 24 · xxl 32 · pill 999`. Cards are `md`,
anything interactive and small is a pill. The reference boards are drawn at
tablet width, where `xl` reads as a gentle curve; on a phone the same radius eats
into a card only a few hundred points wide and the panel starts to look like a
pill, and pills are for things you tap.

Exactly two shadows: `soft` for resting cards, `lifted` for the floating tab bar
and the FAB. Depth means "this floats above the page", never "this is pretty".

The doorway screens — the welcome and the lock screen — open with a brand-purple
panel whose bottom edge sweeps rather than cuts (`CurvedPanel`). It is the one
place the app is allowed a flourish, because it is the one place with nothing to
read: no balance, no list, no decision. Everywhere past it is somebody's money,
and a shape that draws the eye there is a shape competing with a number.

The arc is an over-wide box with a large bottom radius, not an SVG path — the
screen only ever sees the middle of a much wider circle. That keeps
`react-native-svg` out of the dependency list, which matters for a screen that
has to render before anything else in the app does.

The overhang has to scale with the radius, not with the screen. It did not once,
and the sign-in header shipped as a plain rectangle: the panel was short, so the
radius was small, so the whole arc sat off the sides of the screen and the flat
middle was all that showed. The arithmetic and its three caps now live in
`packages/ui/src/curve.ts`, on their own and tested, because nothing about that
failure looked like a failure.

## Meeting Baaki for the first time

Three full-bleed pastel cards before the welcome — what you get for free, that
the people you split with need no account, and that settling hands the amount to
UPI. Swipeable, skippable from the first frame, shown once and never again.

It is emoji rather than illustration, at the same size art would be. Art means a
binary asset in every build, and these are the frames that render before the app
has proved anything about itself; the group covers are emoji for the same reason,
so the tour looks like the product rather than a brochure stapled to the front of
it.

## Lists somebody has to aim at

The contact picker is the one screen where the data is not ours and can be
enormous — a phone with nine hundred names in it. It borrows the shape of the
phone's own contacts app rather than inventing one: the count in the search
field, letter headings that stick as you scroll, and an index rail down the
right side. Nobody has to learn it, and a thousand rows stops being something
you scroll and becomes something you aim at.

The rail's letters come from the contacts rather than a hard-coded A–Z, so an
address book of Tamil or Devanagari names gets a rail that matches it instead of
filing everyone under `#`. When there are more letters than fit, it shows every
nth: a squashed complete alphabet is worse at aiming than a sparse one.

`@shopify/flash-list` does the recycling — sections are one flat array of
headings and people, with `getItemType` telling it the two are different shapes.
The rail is ours, forty lines, because every published React Native
alphabet-index component was abandoned years ago.

## Spacing

4px base: `xs 4 · sm 8 · md 12 · lg 16 · xl 20 · xxl 24 · xxxl 32`. Screens use
`xl` horizontal padding; scroll containers reserve ~170px at the bottom so the
floating tab bar never covers the last row.

## Components

`Screen · Card · TintCard · CurvedPanel · Gradient · Text · Button · IconButton · Fab ·
Chip · ChipRow · Badge · Avatar · AvatarStack · ListRow · EmptyState ·
MoneyText · Toggle · PillTabBar · AmountKeypad`

Two carry product decisions rather than styling:

- **`AmountKeypad`** — the calculator lives inside the amount field (TDR §9,
  the 955-vote fix). Splitting a bill means arithmetic; making people leave for
  another app to do it is the bug. All of its maths is integer minor units, and
  `÷` rounds exactly the way the split engine does.
- **`Avatar` (ghost variant)** — members who have not joined yet (ADR-006) get a
  dashed ring. A ghost holds real balances, so it must look present but
  provisional, never like an error.

## Screens (M0)

Home · Activity · Account · Group (expenses / balances / activity) ·
Add expense · Settle up · Who pays whom.

All of them run on fixture data, but every number they show is computed by
`@baaki/core` — shares, balances, pairwise edges and simplification — so the
wiring is real and M1 only swaps the data source.
