# Waves design system

Derived from the two reference boards supplied at kickoff. Both share the same
skeleton, and Waves takes it wholesale: a lavender canvas, white cards with
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
business, not ours: `formatParts` in `@waves/core` cuts the string at the
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

Exactly two shadows: `soft` for resting cards, `lifted` for the header overflow
menu and the FAB. Depth means "this floats above the page", never "this is
pretty". The bottom bar is the exception that proves it — it sits flat on the
page behind a top hairline rather than floating on a shadow (see **Bottom
navigation**).

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

## Meeting Waves for the first time

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

## A screen with three faces

The account screen opens with a hero rather than a title: the avatar, the name,
and one number in a pill under it. Below that, `SegmentedTabs` splits what used
to be a single long scroll into **You · Paying · Settings**.

`SegmentedTabs` is not `PillTabBar`. The bottom bar spans the foot of every
screen and moves you between destinations; this sits in the page, under a rule,
because the page you are on has three faces and this chooses which one. A bar and
an in-page switch read as two different things — where you can go, and which face
of this page you are on — which is the point.

The pill under the name is **what has actually changed hands through you** —
settled settlements only, per currency, in both directions. The board this was
drawn from puts a points total there, and Waves has none: a score next to
somebody's money is a number that means nothing sitting among numbers that mean
everything. It is deliberately _not_ coloured like a balance, because paying and
being paid are the same fact here — a debt closed. Currencies are counted rather
than added; no rate turns rupees into euros, and this would be the only place in
the app that guessed at money.

## Choosing a language, and the restart it sometimes costs

The phone's language is the default and stays the default. A picker exists on
top of it because a phone is one setting for one person and the two do not
always agree: somebody in Chennai with an English phone still reads Tamil
faster, and a visitor's phone is in Arabic while their group is not.

Each language is listed in its own script first, with the English name under it.
Somebody who has opened the app in a language they cannot read is scanning for
the **shape** of their own writing, and "Tamil" spelled in Latin letters is not
that shape. The two words the picker is reached by — Language and Upgrade —
are the only settings labels that are translated, for the same reason: a row
labelled in the language you are trying to escape is no help at all.

Words change instantly. **Direction does not.** React Native decides
right-to-left natively, before any JavaScript runs, and `forceRTL` says so
itself — _changes take full effect on the next application start_. There is no
reload to call. So the screen says "close and open Waves again" in a banner that
stays until it is true, rather than half-mirroring a screen and calling it done.

The banner alone was not enough, twice over. A banner lives on one screen, and
somebody who taps a language and walks away never reads it — they come back to a
mirrored app in a language that is no longer Arabic and report it as broken. So
the words are also said in an alert, at the moment of the choice, in the
language just chosen, and only when the direction actually turns: going Arabic →
English → Arabic in one sitting ends where the app launched and has nothing left
to restart for. The sentence has **two directions** and they are not
interchangeable — telling somebody who has just chosen English that reopening
will "mirror it" describes the opposite of what will happen, on the one screen
they are reading to find out why it has not turned back.

Since `expo-updates` was added, the app can restart itself, so the alert
**offers** rather than instructs. It still asks: throwing somebody out of the
screen they are standing on is not a thing to do without permission, and the
banner keeps a Restart button for whoever says "not now" and changes their mind.
Builds that cannot do it — anything older than the binary that added the module,
and any reload the platform refuses — fall back to the sentence that was always
true. That check has to be `requireOptionalNativeModule('ExpoUpdates')` rather
than a `try`/`catch` around the import: `expo-updates` calls
`requireNativeModule` at its own module scope, and that throw reaches the global
error handler on the way past, so the red box appears even though the catch runs.

The choice is offered twice, and the second time is the important one. A
settings row is the right home for it once somebody is inside the app; it is the
wrong home for somebody standing at the front door who cannot read the door.
So the four scripts also sit flat on the sign-in screen, under the buttons —
four chips, endonyms only, no "follow my phone" among them, because following
the phone is what the app is already doing and a row of five where one is an
English sentence has stopped being scannable. In the settings list Language
leads rather than sits fifth, for the same reason: a row you can only reach by
reading past rows you cannot read is a row that is not there.

Two consequences worth stating, because both are the kind of thing that looks
like a bug when it is right:

- **The icons follow the screen, not the choice.** `setLayoutDirection` is given
  the direction the app actually launched in, so between choosing Arabic and
  restarting the arrows keep pointing the way the layout still runs. Mirroring
  them on the choice would put backwards chevrons on an unmirrored screen.
- **A choice changes the language, not the country.** The locale keeps the
  phone's region and swaps only the language subtag, so reading the app in Hindi
  in Dubai formats money and dates as `hi-AE`. Where somebody is decides what
  their currency and calendar look like; what they read does not.

## A door with no shop behind it

The Upgrade row leads to a screen that says there is nothing to buy, and says
what would ever cost money: scanning bills, which costs real money per scan, and
outsized exports. The ledger — groups, expenses, splits, balances, settling up,
and getting all of it back out — is free forever and is not on that list.

It sits in its own section above Settings rather than among them. Paying for
something is not a preference, and a row that sells you something between
Notifications and Export is a row dressed up as a setting.

## Spacing

4px base: `xs 4 · sm 8 · md 12 · lg 16 · xl 20 · xxl 24 · xxxl 32`. Screens use
`xl` horizontal padding; scroll containers reserve room at the bottom
(`useTabBarClearance`) so the opaque bottom bar never covers the last row.

## Bottom navigation

The bar is flat and pinned to the bottom edge on **every** screen, WhatsApp
style — a top hairline, no float, no shadow. The selected destination wears a
rounded active-indicator pill behind its icon in the brand's soft tint; its icon
and label take the brand colour, the rest sit muted.

It is rendered once at the root over the whole navigation stack (`AppTabBar`),
not inside the tabs navigator, so it stays put when a screen is pushed on top —
a group, a settings page, the inbox. The tabs navigator keeps the scene
switching but hides its own bar so there is never a second copy. The rules for
when it hides (the camera and the rise-from-bottom modals, the signed-out
screens) and which destination reads as current are pure and tested in
`lib/tabBar.ts` / `test/tabBar.test.ts`.

Four destinations: **Home · Friends · Activity · Inbox**. The account is not one
of them — it is reached from the header avatar, and its settings from the
header's three-dot overflow menu (`OverflowMenu`), a small rounded card that
drops from the top-right over a tap-away scrim. A face you own is a way in, not a
tab.

## Components

`Screen · Card · TintCard · CurvedPanel · Gradient · Text · Button · IconButton · Fab ·
Chip · ChipRow · Badge · Avatar · AvatarStack · ListRow · EmptyState ·
MoneyText · Toggle · PillTabBar · SegmentedTabs · AmountKeypad`

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
`@waves/core` — shares, balances, pairwise edges and simplification — so the
wiring is real and M1 only swaps the data source.
