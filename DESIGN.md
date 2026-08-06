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

### The one rule that is not decorative

**Money colour is semantic and global.** Owed-to-you is always the
positive/mint pair; you-owe is always the negative/pink pair. Nothing else in
the app may use those two colours, because in a ledger app colour is data:
a user should be able to answer "am I up or down?" without reading a digit.

`MoneyText` enforces it — components pass an amount and a mode, never a colour.

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
screen only ever sees the flat middle of a much wider ellipse. That keeps
`react-native-svg` out of the dependency list, which matters for a screen that
has to render before anything else in the app does.

## Spacing

4px base: `xs 4 · sm 8 · md 12 · lg 16 · xl 20 · xxl 24 · xxxl 32`. Screens use
`xl` horizontal padding; scroll containers reserve ~170px at the bottom so the
floating tab bar never covers the last row.

## Components

`Screen · Card · TintCard · CurvedPanel · Text · Button · IconButton · Fab ·
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
