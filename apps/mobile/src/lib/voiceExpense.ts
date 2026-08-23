/**
 * Turning a spoken sentence into the bones of an expense — the part that needs
 * no microphone, no network and no model, so it can be tested on its own.
 *
 * "add 500 rupees to the Goa trip" carries three things a form needs: an amount,
 * a currency, and which group it belongs to. This pulls those out with plain
 * rules — a number, a currency word, a group whose name the sentence mentions —
 * and hands back whatever it is sure of, leaving the rest null for the screen to
 * ask about. It never guesses a group it is not sure of: two trips both called
 * "…trip" cancel out rather than pick one.
 *
 * A model can do better with people and split phrasing ("split with Ravi and
 * me"), and when a key is present the caller layers that on top — but the amount
 * and the group are cheap and certain here, and everyone gets them.
 */

/** The minimum a group needs to be matched by name. */
export interface VoiceGroupRef {
  id: string;
  name: string | null;
}

export interface ParsedVoiceExpense {
  /** The amount in minor units (a two-decimal assumption), or null if none was heard. */
  amountMinor: bigint | null;
  /** The amount as spoken, in major units, or null. */
  amountMajor: number | null;
  /** An ISO currency guessed from a currency word, or null. */
  currency: string | null;
  /** What is left of the sentence once the amount, currency, group and split words are removed. */
  note: string;
  /** The group the sentence names, or null when none or more than one fits. */
  groupId: string | null;
  /**
   * How many people to split among, when the sentence says so ("split among 3",
   * "3 ways") — or null. A bare count names nobody, so it can't pick members on
   * its own; matching spoken names does that ({@link matchMemberNames}). It is
   * kept mainly so the count is never mistaken for the amount.
   */
  splitCount: number | null;
}

/** Currency words to ISO codes. Indian-first, then the common cross-border ones. */
const CURRENCY_WORDS: readonly (readonly [RegExp, string])[] = [
  [/\b(rupees?|rupaye|rs|inr)\b|₹/i, 'INR'],
  [/\b(dollars?|usd|bucks?)\b|\$/i, 'USD'],
  [/\b(euros?|eur)\b|€/i, 'EUR'],
  [/\b(pounds?|quid|gbp)\b|£/i, 'GBP'],
  [/\b(dirhams?|aed)\b/i, 'AED'],
];

/** Words that carry no meaning for matching or for the note. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'add',
  'a',
  'an',
  'and',
  'the',
  'to',
  'for',
  'in',
  'into',
  'of',
  'on',
  'spent',
  'spend',
  'paid',
  'pay',
  'expense',
  'my',
  'our',
  // Split phrasing — not part of a description or a group name.
  'split',
  'splits',
  'divide',
  'share',
  'among',
  'amongst',
  'between',
  'ways',
  'way',
  'each',
  'equally',
  'equal',
  'people',
  'person',
  'ppl',
  'folks',
  'heads',
  'us',
  'with',
  'by',
]);

/** A number sitting next to a currency word or symbol — the amount, said plainly. */
const CURRENCY_ADJACENT =
  /(?:₹|\$|€|£)\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:rupees?|rupaye|rs|inr|dollars?|usd|bucks?|euros?|eur|pounds?|quid|gbp|dirhams?|aed)\b/i;

/**
 * A count of people to split among: "among 3", "between 4", "3 people", "3 ways".
 * Anchored to a split word or a people/ways word so the amount right after
 * "split" ("split 500 …") is never taken as the count.
 */
const SPLIT_COUNT =
  /\b(?:among|amongst|between)\s+(\d+)\b|\b(\d+)\s*(?:people|persons?|ppl|ways?|folks?|heads?)\b/i;

/** Lowercase word tokens, punctuation and symbols stripped. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** A matched numeric string to a positive number, commas removed — or null. */
function toAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseFloat(raw.replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** How many people to split among, if the sentence says — else null. */
function extractSplitCount(text: string): number | null {
  const match = text.match(SPLIT_COUNT);
  if (!match) return null;
  const count = Number.parseInt(match[1] ?? match[2] ?? '', 10);
  return Number.isFinite(count) && count > 0 ? count : null;
}

/**
 * The amount, kept apart from a split count.
 *
 * "split 500 among 3 people" has two numbers; only one is money. A number next
 * to a currency word or symbol wins outright. Failing that, the split-count
 * phrase is removed and the first number left standing is the amount — so the
 * "3" in "3 people" is never mistaken for it.
 */
function extractAmount(text: string): number | null {
  const adjacent = text.match(CURRENCY_ADJACENT);
  if (adjacent) return toAmount(adjacent[1] ?? adjacent[2]);

  const withoutCount = text.replace(SPLIT_COUNT, ' ');
  const first = withoutCount.match(/\d[\d,]*(?:\.\d+)?/);
  return toAmount(first?.[0]);
}

/** Which currency, if any, the sentence names. */
function detectCurrency(text: string): string | null {
  for (const [pattern, code] of CURRENCY_WORDS) {
    if (pattern.test(text)) return code;
  }
  return null;
}

/**
 * The group the sentence names, if exactly one fits.
 *
 * A named group's words are matched against the sentence's, ignoring the small
 * words either might share. The group with the most words in common wins — but
 * only if it wins outright: a tie (two "…trip" groups, nothing else said) is
 * treated as no match, so the screen asks rather than guessing wrong.
 */
function matchGroup(tokens: readonly string[], groups: readonly VoiceGroupRef[]): string | null {
  const heard = new Set(tokens.filter((token) => !STOPWORDS.has(token)));
  if (heard.size === 0) return null;

  let best: { id: string; score: number } | null = null;
  let tied = false;

  for (const group of groups) {
    if (!group.name) continue;
    const nameTokens = tokenize(group.name).filter((token) => !STOPWORDS.has(token));
    const score = nameTokens.reduce((count, token) => count + (heard.has(token) ? 1 : 0), 0);
    if (score === 0) continue;
    if (!best || score > best.score) {
      best = { id: group.id, score };
      tied = false;
    } else if (score === best.score) {
      tied = true;
    }
  }

  return best && !tied ? best.id : null;
}

/**
 * The words left once the amount, currency and named group are taken out — the
 * description someone would have typed. Numbers, currency words, the stopwords,
 * and any word from the matched group's name are all dropped.
 */
function buildNote(transcript: string, matchedGroupName: string | null): string {
  const nameTokens = new Set(matchedGroupName ? tokenize(matchedGroupName) : []);
  const currencyWord =
    /\b(rupees?|rupaye|rs|inr|dollars?|usd|bucks?|euros?|eur|pounds?|quid|gbp|dirhams?|aed)\b/gi;

  return transcript
    .replace(currencyWord, ' ')
    .replace(/[₹$€£]/g, ' ')
    .replace(/\d[\d,]*(?:\.\d+)?/g, ' ')
    .split(/\s+/)
    .filter((word) => {
      const token = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (!token) return false;
      if (STOPWORDS.has(token)) return false;
      if (nameTokens.has(token)) return false;
      return true;
    })
    .join(' ')
    .trim();
}

/**
 * Parse a transcript against the reader's groups. Pure: same sentence and same
 * groups always give the same answer.
 */
export function parseVoiceExpense(
  transcript: string,
  groups: readonly VoiceGroupRef[],
): ParsedVoiceExpense {
  // Spoken numbers become digits first; every pattern below is digit-based.
  const said = normalizeSpokenNumbers(normalizeDigits(transcript));
  const tokens = tokenize(said);
  const amountMajor = extractAmount(said);
  const amountMinor = amountMajor === null ? null : BigInt(Math.round(amountMajor * 100));
  const groupId = matchGroup(tokens, groups);
  const matchedName = groupId ? (groups.find((group) => group.id === groupId)?.name ?? null) : null;

  return {
    amountMinor,
    amountMajor,
    currency: detectCurrency(said),
    note: buildNote(said, matchedName),
    groupId,
    splitCount: extractSplitCount(said),
  };
}

/**
 * The members a sentence names, by id.
 *
 * Each member's display name is matched word-for-word against the sentence, so
 * "split with Ravi and Priya" picks Ravi and Priya out of the group. This is the
 * precise half of splitting by voice — a bare "3 people" names nobody, but named
 * people map straight to rows. Runs where the members are known (the add-expense
 * form), not in the parser, which only sees group names.
 *
 * Two-letter-plus name words only, and the split/filler words are ignored, so a
 * member called "A" or the word "with" never matches by accident.
 */
export function matchMemberNames(
  text: string,
  members: readonly { id: string; name: string }[],
): string[] {
  const heard = new Set(tokenize(text));
  const ids: string[] = [];
  for (const member of members) {
    const nameTokens = tokenize(member.name).filter(
      (token) => token.length >= 2 && !STOPWORDS.has(token),
    );
    if (nameTokens.some((token) => heard.has(token))) ids.push(member.id);
  }
  return ids;
}

/**
 * The note with any member's name taken out.
 *
 * A spoken name is split information, not a description — "dinner with Ravi"
 * describes dinner, and Ravi becomes a row, not a word in the note. Removes
 * every member name word (two letters or more) so the description that reaches
 * the form is just what was spent on.
 */
export function stripMemberNames(
  note: string,
  members: readonly { id: string; name: string }[],
): string {
  const nameTokens = new Set(
    members.flatMap((member) => tokenize(member.name)).filter((token) => token.length >= 2),
  );
  return note
    .split(/\s+/)
    .filter((word) => {
      const token = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      return token !== '' && !nameTokens.has(token);
    })
    .join(' ')
    .trim();
}

/* ─────────────────────────────────────────────────────────────────────────
 * Several expenses in one breath, an optional "make a group", and a nudge
 * toward other languages.
 *
 * The single-expense parser above is the certain core. This layer sits on top
 * for the fuller request: "five rupees for snacks, ten for tea, shopping 1000"
 * is four expenses, not one; "make a group called Goa and add 500" both creates
 * a group and files an expense into it. None of it needs a model — but a model
 * does all of it better across languages, so when a key is present the caller
 * prefers {@link interpretVoiceExpenses} and falls back to this only when there
 * is no key or the call fails.
 * ───────────────────────────────────────────────────────────────────────── */

/** One expense lifted out of a possibly-multi sentence. Always has an amount. */
export interface VoiceExpenseItem {
  amountMinor: bigint;
  amountMajor: number;
  currency: string | null;
  note: string;
}

/**
 * What the sentence says to do about a group: name an existing one, ask for a
 * new one by name, or neither (the screen defaults such expenses to the capture
 * inbox, unassigned).
 */
export type VoiceGroupTarget =
  { kind: 'existing'; groupId: string } | { kind: 'create'; name: string } | null;

/** The whole of what a spoken sentence asked for. */
export interface VoiceParseResult {
  items: VoiceExpenseItem[];
  group: VoiceGroupTarget;
  /** A split count, when one was heard — carried through for the group case. */
  splitCount: number | null;
}

/**
 * Native numerals to ASCII, so "५०० रुपये" and "௫" and "٥" all read as numbers.
 * Devanagari, Tamil, Arabic-Indic and Eastern-Arabic (Persian/Urdu) digits are
 * the ones this app's four locales and their neighbours actually type or speak.
 */
const NATIVE_DIGIT_BLOCKS: readonly number[] = [0x0966, 0x0be6, 0x0660, 0x06f0];

export function normalizeDigits(text: string): string {
  return text.replace(/[०-९௦-௯٠-٩۰-۹]/g, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    for (const base of NATIVE_DIGIT_BLOCKS) {
      if (code >= base && code <= base + 9) return String(code - base);
    }
    return ch;
  });
}

/** Words for numbers, and the Indian/Western multipliers that scale them. */
const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  ['zero', 0],
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12],
  ['thirteen', 13],
  ['fourteen', 14],
  ['fifteen', 15],
  ['sixteen', 16],
  ['seventeen', 17],
  ['eighteen', 18],
  ['nineteen', 19],
  ['twenty', 20],
  ['thirty', 30],
  ['forty', 40],
  ['fourty', 40],
  ['fifty', 50],
  ['sixty', 60],
  ['seventy', 70],
  ['eighty', 80],
  ['ninety', 90],
]);

/** Scaling words. `group` ones close off a chunk ("two thousand five hundred"). */
const NUMBER_MULTIPLIERS: ReadonlyMap<string, { factor: number; group: boolean }> = new Map([
  ['hundred', { factor: 100, group: false }],
  ['thousand', { factor: 1_000, group: true }],
  ['lakh', { factor: 100_000, group: true }],
  ['lakhs', { factor: 100_000, group: true }],
  ['lac', { factor: 100_000, group: true }],
  ['lacs', { factor: 100_000, group: true }],
  ['crore', { factor: 10_000_000, group: true }],
  ['crores', { factor: 10_000_000, group: true }],
  ['million', { factor: 1_000_000, group: true }],
  ['billion', { factor: 1_000_000_000, group: true }],
]);

/** Any single word that can appear inside a spoken number. */
const NUMBER_WORD_RE = [...NUMBER_WORDS.keys(), ...NUMBER_MULTIPLIERS.keys()].join('|');

/** A run of number words, joined by spaces, hyphens or a linking "and". */
const SPOKEN_NUMBER = new RegExp(
  `\\b(?:${NUMBER_WORD_RE})(?:[\\s-]+(?:and[\\s-]+)?(?:${NUMBER_WORD_RE}))*\\b`,
  'gi',
);

/**
 * A currency word or symbol — the signal that a nearby number is money.
 *
 * The alphabetic words carry word boundaries so a short token like "rs" cannot
 * match inside an ordinary word ("person" → "pe-rs-on"): without them "one
 * person paid" would read "rs" as currency and mint a false amount.
 */
const CURRENCY_TOKEN =
  /(?:₹|\$|€|£|\b(?:rupees?|rupaye|rs|inr|dollars?|usd|bucks?|euros?|eur|pounds?|quid|gbp|dirhams?|aed)\b)/i;

/** Split-phrase context — a number here is a people count, still worth digitising. */
const SPLIT_BEFORE_WORD = /^(?:among|amongst|between)$/i;
const SPLIT_AFTER_WORD = /^(?:people|persons?|ppl|ways?|folks?|heads?)\b/i;

/** Add up one run of number words: "five hundred and fifty" → 550. */
function spokenRunToNumber(run: string): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const word of run.toLowerCase().split(/[\s-]+/)) {
    if (!word || word === 'and') continue;
    const unit = NUMBER_WORDS.get(word);
    if (unit !== undefined) {
      current += unit;
      seen = true;
      continue;
    }
    const mult = NUMBER_MULTIPLIERS.get(word);
    if (!mult) return null;
    // A bare "hundred"/"thousand" means one of them.
    current = (current === 0 ? 1 : current) * mult.factor;
    if (mult.group) {
      total += current;
      current = 0;
    }
    seen = true;
  }
  const value = total + current;
  return seen && value > 0 ? value : null;
}

/**
 * Rewrite spoken numbers as digits, so the digit-based patterns above see them.
 *
 * Dictation hands back what was said, and what people say is "five hundred
 * rupees", not "500 rupees" — every amount pattern here is `\d`-based, so
 * without this the sentence parses to no amount at all and the expense is
 * silently dropped.
 *
 * Deliberately conservative: a run is only rewritten when it carries a
 * multiplier ("five hundred"), sits against a currency word ("twenty rupees"),
 * or sits in a split-count phrase ("split among five", "five people") — where
 * the number is a people count that extractSplitCount, being digit-only, would
 * otherwise miss. A bare small number in any other context is left alone,
 * because "one of us" and "table for two" are ordinary speech, and turning them
 * into digits would invent an amount out of a sentence that never named one.
 */
export function normalizeSpokenNumbers(text: string): string {
  return text.replace(SPOKEN_NUMBER, (run, offset: number, whole: string) => {
    const words = run
      .toLowerCase()
      .split(/[\s-]+/)
      .filter((w: string) => w && w !== 'and');
    const hasMultiplier = words.some((w: string) => NUMBER_MULTIPLIERS.has(w));
    const after = whole.slice(offset + run.length).trimStart();
    const before = whole.slice(0, offset).trimEnd();
    const prevWord = before.split(/\s+/).pop() ?? '';
    const nextIsCurrency = CURRENCY_TOKEN.test(after.split(/\s+/)[0] ?? '');
    const prevIsCurrency = CURRENCY_TOKEN.test(prevWord);
    const splitContext = SPLIT_BEFORE_WORD.test(prevWord) || SPLIT_AFTER_WORD.test(after);
    if (!hasMultiplier && !nextIsCurrency && !prevIsCurrency && !splitContext) return run;
    const value = spokenRunToNumber(run);
    return value === null ? run : String(value);
  });
}

/**
 * A spoken "make a group" and the name it gives.
 *
 * Matches "create/make/start/new/open [a] [new] group [called/named/for] X",
 * where X runs to the first joining word ("and", "then", ",", "with") or the
 * end. Returns the trimmed name and the sentence with that whole clause cut out,
 * so what remains can still be parsed for expenses ("make a group Goa and add
 * 500 for lunch" leaves "add 500 for lunch"). Null when no such intent is heard.
 */
export function detectCreateGroup(transcript: string): { name: string; rest: string } | null {
  const pattern =
    /\b(?:create|make|start|open|add|new)\s+(?:a\s+)?(?:new\s+)?group\s+(?:called|named|for|titled|as|:)?\s*/i;
  const head = transcript.match(pattern);
  if (!head || head.index === undefined) return null;

  const after = transcript.slice(head.index + head[0].length);
  // The name is everything up to a joining word that starts the next clause, or
  // the end. "and/then/with/plus" and a comma each end the name.
  const nameMatch = after.match(/^(.*?)(?:\s+(?:and|then|with|plus|also)\b|\s*[,;]|$)/i);
  const name = (nameMatch?.[1] ?? after).trim().replace(/[.\s]+$/, '');
  if (!name) return null;
  // A name that opens with a joining word is not a name: "create a group and add
  // 100" names nothing. Treat the clause as missing so the rest parses normally.
  if (/^(?:and|then|with|plus|also)\b/i.test(name)) return null;

  // Consume the whole name match — name *and* the joining word that ended it
  // ("and", a comma) — so the joiner does not lead the leftover sentence.
  const consumed = head[0].length + (nameMatch?.[0]?.length ?? after.length);
  const rest = (
    transcript.slice(0, head.index) +
    ' ' +
    transcript.slice(head.index + consumed)
  ).trim();
  return { name, rest };
}

/**
 * The sentence broken into one piece per expense.
 *
 * People list expenses with commas and "and" ("5 for snacks, 10 for tea and 20
 * for the cab"), and also just by starting the next amount ("snacks 5 tea 10").
 * We split on the explicit separators first; any piece that still holds more
 * than one currency-adjacent amount is split again just before each amount, so
 * a run with no commas still comes apart. Pieces with no amount are dropped by
 * the caller.
 */
function segmentExpenses(text: string): string[] {
  // Take out "split among 4" / "4 people" first, so the count is never scanned
  // as an amount and turned into a phantom expense. The caller keeps the count
  // separately (extractSplitCount reads the untouched body), so nothing is lost.
  const withoutCount = text.replace(new RegExp(SPLIT_COUNT.source, 'gi'), ' ');
  const bySeparator = withoutCount
    .split(/\s*,\s*|\s+and\s+|\s*;\s*|\s+then\s+|\n+/i)
    .map((piece) => piece.trim())
    .filter(Boolean);

  const pieces: string[] = [];
  const amountRe = /\d[\d,]*(?:\.\d+)?/g;
  for (const piece of bySeparator) {
    // Where each amount starts. One or none leaves the piece whole; several
    // means a run with no separators ("5 snacks 10 tea"), cut just before every
    // amount after the first so each amount keeps the words that follow it. The
    // text before the first amount stays with it (a label may lead: "snacks 5").
    const starts: number[] = [];
    amountRe.lastIndex = 0;
    for (let m = amountRe.exec(piece); m !== null; m = amountRe.exec(piece)) starts.push(m.index);
    if (starts.length <= 1) {
      pieces.push(piece);
      continue;
    }
    for (let i = 0; i < starts.length; i += 1) {
      const from = i === 0 ? 0 : starts[i];
      const to = i + 1 < starts.length ? starts[i + 1] : piece.length;
      const chunk = piece.slice(from, to).trim();
      if (chunk) pieces.push(chunk);
    }
  }
  return pieces.filter(Boolean);
}

/**
 * Parse a transcript into one or more expenses, plus any group instruction.
 *
 * Pure and model-free: the heuristic fallback for {@link interpretVoiceExpenses}.
 * A create-group clause is lifted out first; the rest is segmented, each segment
 * parsed for an amount/currency/note, and segments with no amount dropped. A
 * currency named in one segment carries to later segments that name none, so
 * "5 rupees snacks, 10 tea" makes both INR. When exactly one expense and no new
 * group are found, the named existing group (if any) is attached.
 */
export function parseVoiceExpenses(
  transcript: string,
  groups: readonly VoiceGroupRef[],
): VoiceParseResult {
  const normalized = normalizeSpokenNumbers(normalizeDigits(transcript));
  const created = detectCreateGroup(normalized);
  const body = created ? created.rest : normalized;

  // The group is settled before the notes are built, so each note can have the
  // named group's words taken out ("dinner on the Goa trip" → note "dinner").
  let group: VoiceGroupTarget = null;
  let matchedName: string | null = null;
  if (created) {
    group = { kind: 'create', name: created.name };
  } else {
    const groupId = matchGroup(tokenize(body), groups);
    if (groupId) {
      group = { kind: 'existing', groupId };
      matchedName = groups.find((candidate) => candidate.id === groupId)?.name ?? null;
    }
  }

  const segments = segmentExpenses(body);
  const items: VoiceExpenseItem[] = [];
  let carriedCurrency: string | null = null;

  for (const segment of segments) {
    const amountMajor = extractAmount(segment);
    if (amountMajor === null) continue;
    const currency: string | null = detectCurrency(segment) ?? carriedCurrency;
    if (currency) carriedCurrency = currency;
    items.push({
      amountMajor,
      amountMinor: BigInt(Math.round(amountMajor * 100)),
      currency,
      note: buildNote(segment, matchedName),
    });
  }

  // Nothing segmented out but there is still a single amount — treat the whole
  // sentence as one expense, matching the single-expense parser's reach.
  if (items.length === 0) {
    const one = parseVoiceExpense(body, groups);
    if (one.amountMinor !== null && one.amountMajor !== null) {
      items.push({
        amountMinor: one.amountMinor,
        amountMajor: one.amountMajor,
        currency: one.currency,
        note: one.note,
      });
    }
  }

  return { items, group, splitCount: extractSplitCount(body) };
}
