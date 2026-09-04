# Splitting an expense — scenarios and guarantees

How Waves turns one bill into per-person shares, what is checked, and where the
decision is actually made.

The rules here are set by three ADRs: money is integer minor units and never a
float (ADR-003), splits are deterministic with a defined remainder rule
(ADR-009), and the server recomputes every share rather than trusting a client
(TDR §4). Everything below is enforced by `packages/core/src/split/` and tested
by `packages/core/test/split.combinations.test.ts`.

---

## 1. The three ways a person divides a bill

| In the app      | `split_params.kind` | What the user supplies                                    | Example              |
| --------------- | ------------------- | --------------------------------------------------------- | -------------------- |
| **Percentage**  | `percent`           | Integer basis points per person, summing to exactly 10000 | Asha 60%, Ravi 40%   |
| **Fixed value** | `exact`             | An exact amount per person, summing to the total          | Asha ₹600, Ravi ₹400 |
| **Share**       | `shares`            | Non-negative integer weights                              | Asha 3, Ravi 2       |

Three more exist for cases the UI drives rather than the user: `equal` (the
default), `adjustment` ("Ravi also had the ₹120 beer, split the rest evenly")
and `itemized` (ADR-008 receipt scanning). They obey the same guarantees and are
covered by the same property suite.

**Basis points, not percentages.** `percent` takes 6000, not 60 or 60.0. A
percentage stored as a float is a rounding bug waiting for a big enough bill;
basis points give one hundredth of a percent of resolution in an integer, which
is finer than any real split needs.

---

## 2. What is guaranteed

Every split, of every type, satisfies all five:

1. **The shares sum to the total, exactly.** Not to within a paisa — exactly.
   `computeShares` asserts this before returning and throws `SHARE_MISMATCH` if
   it ever fails, which would be a bug in Waves rather than in the input.
2. **Every participant gets a row**, even when their share is zero, so the
   screen and the `expense_shares` table always agree on who is involved.
3. **Nobody pays more than the bill, and nobody pays a negative share** — unless
   the user explicitly typed a negative fixed value, which is how a credit or a
   refund is recorded.
4. **Proportionality.** With weights, each person gets the floor of their exact
   share, plus at most one extra minor unit from the remainder pass. A zero
   weight always means zero.
5. **Determinism.** The same inputs give the same output on every device, on the
   server, and on every future run. Listing participants in a different order
   changes nothing.

### The remainder

₹10 between three people is 333.33 paise each, which does not exist. Waves gives
everyone 333 and hands out the leftover paisa one unit at a time, in sorted
member order, **starting at an offset derived from the expense id**
(FNV-1a hash, ADR-009).

That last part is the point. Always starting at the first member would quietly
overcharge whoever sorts first, on every bill, forever. Rotating by expense id
keeps it fair over time while staying perfectly reproducible — the phone that is
offline computes the same answer the server will.

---

## 3. What is rejected, and what the user is told

Every rejection is a `SplitError` with a machine-readable `code`. The client
branches on the code; the message is for a person.

| Code                      | When                                                                 | Applies to      |
| ------------------------- | -------------------------------------------------------------------- | --------------- |
| `PERCENT_SUM_MISMATCH`    | Basis points do not total 10000                                      | percent         |
| `EXACT_SUM_MISMATCH`      | Fixed values do not total the expense                                | exact           |
| `NO_POSITIVE_WEIGHT`      | Every weight is zero                                                 | shares          |
| `INVALID_WEIGHT`          | A weight or basis point is negative, fractional, `NaN` or `Infinity` | percent, shares |
| `UNKNOWN_MEMBER`          | A share is given to somebody outside the split                       | all             |
| `EMPTY_PARTICIPANTS`      | Nobody is in the split                                               | all             |
| `DUPLICATE_PARTICIPANT`   | The same person listed twice                                         | all             |
| `NEGATIVE_TOTAL`          | The expense total itself is negative                                 | all             |
| `UNCLAIMED_ITEM`          | A receipt line nobody has claimed                                    | itemized        |
| `ITEMIZED_TOTAL_MISMATCH` | Items plus tax/tip/discount ≠ the total                              | itemized        |

A percentage split that comes to 99.99% is **refused, not rounded**. Silently
absorbing the missing hundredth would mean the app decided who pays it, and the
one thing an expense splitter cannot do is invent money.

---

## 4. Where the calculation happens

**On the server, always.** The client computes shares too, but only ever as a
preview and to keep working offline — its numbers are never what gets stored.

```
 phone                          edge function                       Postgres
 ─────                          ─────────────                       ────────
 computeShares(...)  ──┐
 (preview / offline)   │
                       ├─▶  computeShares(split_params)   ──▶  waves_apply_expense
 expectedShares ───────┘     verifyClientShares(...)            (one transaction)
                             409 SHARE_MISMATCH on disagreement       │
                                                                     ▼
                                                      Σ payers = Σ shares = amount
                                                      (constraint trigger)
```

Three separate defences, each of which would catch a wrong number on its own:

1. **The edge functions recompute.** `expense-write` and `sync` both call
   `computeShares` on `split_params` and use _their_ result. A client's
   `expectedShares` is only ever compared, never stored. The comparison is
   `verifyClientShares` in `@waves/core` — one definition shared by both
   functions, including the case a hand-written loop tends to miss, where the
   client invents a share for somebody who is not in the split.
2. **The database enforces the money invariant.** A constraint trigger checks
   `Σ payers = Σ shares = amount` inside the same transaction that writes the
   expense. Even a compromised edge function cannot store an expense that does
   not balance.
3. **Balances are derived, never stored as a running total** (ADR-004), and CI
   asserts the derived tables equal a ground-truth aggregate on every push.

There is no channel through which a caller can supply a share. `computeShares`
takes only the total, the parameters, the participants and the seed — so "the
calculation happens in the backend" is structural rather than a matter of
discipline. A test asserts exactly that by trying to smuggle a `shares` field
into `split_params` and confirming the result is unchanged.

---

## 5. The test matrix

`packages/core/test/split.combinations.test.ts` walks a defined space
completely, rather than sampling it. The property suite next to it does the
random-input half; this one guarantees the same cases run every time.

**The space**

| Dimension       | Values                                                |
| --------------- | ----------------------------------------------------- |
| Participants    | 2, 3, 4, 5                                            |
| Amounts (paise) | 0, 1, 7, 100, 333, 999, 1000, 100000, 123457          |
| Weight vectors  | every composition of 10 units across the participants |

"Every composition of 10 units" means all the ways ten shares can be handed out:
`[10,0]`, `[9,1]`, … `[0,10]` for two people, and so on — 11, 66, 286 and 1001
vectors for 2, 3, 4 and 5 people. For percentages each unit is 1000 basis
points, so this is every whole multiple of 10% that adds to 100%.

That is **1364 weight vectors × 9 amounts × 2 weighted types**, plus a fixed
value case derived from each result: roughly 25,000 computations, every one
checked against all five guarantees above.

The amounts are chosen for their remainders, not their realism: 1000 across 3
leaves 1 over, 999 across 4 leaves 3, 123457 is prime to everything here, and 0
and 1 are the edges where an off-by-one hides.

**Cross-type equivalences** — the same instruction expressed two ways must
produce the same money, down to which person absorbs the leftover paisa:

- 3:1 shares == 75%:25% percentage
- uniform shares (1:1:1) == an equal split
- any percentage or share result, fed back as fixed values, reproduces itself

**Fairness** — over 60 different expense ids, an equal three-way split of ₹10
lands its extra paisa on all three people, not always the same one.

**Server authority** — a client that is one paisa out, omits somebody, invents
somebody, or sends `"five hundred"` instead of a number is rejected; a client
that claims nothing is accepted, because an offline device that has not
recomputed simply takes the server's word.

---

## 6. Worked examples

All amounts in paise. Seed is the expense id.

### Percentage, with a remainder

₹10.00 (1000 paise), Asha 60% / Ravi 30% / Priya 10%.

| Person | Basis points | Exact | Floor | Final |
| ------ | ------------ | ----- | ----- | ----- |
| Asha   | 6000         | 600.0 | 600   | 600   |
| Ravi   | 3000         | 300.0 | 300   | 300   |
| Priya  | 1000         | 100.0 | 100   | 100   |

No remainder. Change the bill to ₹10.01 (1001) and the exact shares become
600.6 / 300.3 / 100.1; the floors are 600 / 300 / 100, leaving 1 paisa, which
goes to whichever member the expense id's hash selects.

### Share

₹100.00 (10000), Asha 3 : Ravi 2. Total weight 5.

| Person | Weight | Exact | Final |
| ------ | ------ | ----- | ----- |
| Asha   | 3      | 6000  | 6000  |
| Ravi   | 2      | 4000  | 4000  |

### Fixed value

₹10.00, Asha ₹6.00 and Ravi ₹4.00 → accepted. Asha ₹6.00 and Ravi ₹4.01 →
`EXACT_SUM_MISMATCH`, because it comes to ₹10.01 and the bill is ₹10.00.

One person may carry the whole bill (`{ asha: 1000 }`); everybody else appears
at zero. A negative entry is allowed as long as the set still sums correctly —
that is how a refund to one person is recorded.

---

## 7. Running it

```bash
pnpm test:core                                  # every split suite
pnpm --filter @waves/core exec vitest run test/split.combinations.test.ts
```

CI runs these on every push, and a merge is blocked if any of them fail
(ADR-014).
