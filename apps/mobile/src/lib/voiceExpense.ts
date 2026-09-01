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

import { CATEGORIES, isCurrencyCode, minorUnitScale, type CategoryId } from '@waves/core';

/** Above this, a voice parse is more likely corrupted or misheard than safe to book. */
export const MAX_VOICE_AMOUNT_MAJOR = 1_000_000_000;

/** Bound model-supplied notes before they reach the review UI. */
export const MAX_VOICE_NOTE_CHARS = 160;

/** Whole-command intents that must not be converted into expenses. */
const UNSUPPORTED_GLOBAL_EXPENSE_INTENT =
  /\b(?:do\s+not|don['’]t|dont|did\s+not\s+pay|didn['’]t\s+pay|didnt\s+pay|not\s+paid|cancel|remove|delete|ignore|not\s+an\s+expense)\b/i;

/** Clause-level intents that can be skipped without discarding neighbouring safe expenses. */
const UNSUPPORTED_EXPENSE_CLAUSE =
  /\b(?:refund(?:ed|s|ing)?|reimburse(?:d|ment|ments|s|ing)?|repay(?:ment|ments|s|ing)?|repaid|pay\s*back|paid\s+(?:me\s+)?back|got\s+(?:paid\s+)?back|received\s+(?:money\s+)?back)\b/i;

const SPOKEN_NEGATIVE_AMOUNT =
  /\b(?:minus|negative)\s+(?=(?:\d|zero\b|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b|eleven\b|twelve\b|thirteen\b|fourteen\b|fifteen\b|sixteen\b|seventeen\b|eighteen\b|nineteen\b|twenty\b|thirty\b|forty\b|fourty\b|fifty\b|sixty\b|seventy\b|eighty\b|ninety\b|hundred\b|thousand\b|lakh\b|lakhs\b|crore\b|crores\b))/i;
const THIRD_PARTY_PAYER_INTENT = /\b(?!(?:i|we|you)\b)[\p{L}][\p{L}'’.-]*\s+paid\b/iu;

function isUnsupportedVoiceExpenseClause(text: string): boolean {
  return (
    UNSUPPORTED_EXPENSE_CLAUSE.test(text) ||
    SPOKEN_NEGATIVE_AMOUNT.test(text) ||
    THIRD_PARTY_PAYER_INTENT.test(text)
  );
}

export function isUnsupportedVoiceExpenseIntent(text: string): boolean {
  return UNSUPPORTED_GLOBAL_EXPENSE_INTENT.test(text) || isUnsupportedVoiceExpenseClause(text);
}

/**
 * Solo-only markers: the whole spend is the speaker's own, so it belongs on the
 * private "Me" ledger (A48) rather than any group. "just me and Ravi" is NOT
 * solo — that is a two-person split — so a marker sitting next to another person
 * cancels it (SELF_WITH_OTHERS). English phrasings only; the model tier catches
 * the rest, and this stays certain and cheap.
 */
const SELF_ONLY_INTENT =
  /\b(?:just|only)\s+(?:for\s+)?(?:me|myself)\b|\bfor\s+myself\b|\bfor\s+my\s+own\b|\bmy\s+own\s+expense\b|\bpersonal\s+expense\b|\bby\s+myself\b|\bon\s+my\s+own\b/i;
const SELF_WITH_OTHERS =
  /\b(?:me|myself)\s+(?:and|&|\+|with|plus)\b|\b(?:and|&|\+|with|plus)\s+(?:me|myself)\b/i;

/** True when the sentence marks the spend as the speaker's alone (no split). */
export function isSelfOnlyVoiceIntent(text: string): boolean {
  return SELF_ONLY_INTENT.test(text) && !SELF_WITH_OTHERS.test(text);
}

/** Take the solo marker out so the note reads clean ("coffee just for me" → "coffee"). */
export function stripSelfOnlyPhrase(text: string): string {
  return text
    .replace(SELF_ONLY_INTENT, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function isSafeVoiceAmount(amountMajor: number): boolean {
  return Number.isFinite(amountMajor) && amountMajor > 0 && amountMajor <= MAX_VOICE_AMOUNT_MAJOR;
}

/** The minimum a group needs to be matched by name. */
export interface VoiceGroupRef {
  id: string;
  name: string | null;
}

/**
 * A spoken major amount to its currency's minor units. A flat ×100 inflated a
 * zero-decimal currency (¥3000 → 300000 = ¥300000) and truncated a three-decimal
 * one; scaling by the currency's real exponent fixes both. Falls back to the
 * common two-decimal scale when the currency is unknown or unheard, which keeps
 * every existing INR/USD case identical.
 */
export function toVoiceMinorUnits(amountMajor: number, currency: string | null): bigint {
  const scale = currency && isCurrencyCode(currency) ? Number(minorUnitScale(currency)) : 100;
  return BigInt(Math.round(amountMajor * scale));
}

export interface ParsedVoiceExpense {
  /**
   * The amount in minor units, scaled by the currency's own exponent when a
   * valid ISO code was heard (so JPY is not inflated ×100, KWD not truncated),
   * falling back to a two-decimal scale when the currency is unknown or invalid.
   * Null if no amount was heard.
   */
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

/**
 * Currency signals — a spoken word, an ISO code, or a symbol — to an ISO-4217
 * code. Indian-first, then the corridors this app's people actually use, then
 * the common cross-border ones. Order matters: a qualified name ("canadian
 * dollars", "sri lankan rupees") and every symbol must come before the bare
 * word it contains ("dollars", "rupees"), because {@link detectCurrency} takes
 * the first that fits.
 *
 * Deliberately left out: bare "lira"/"try" (TRY) — "try" is an ordinary English
 * verb and would mint a false currency on "I'll try the …". A code is only read
 * when it stands as its own word.
 */
export const VOICE_SUPPORTED_CURRENCY_CODES = new Set([
  'AED',
  'AUD',
  'BDT',
  'BRL',
  'CAD',
  'CHF',
  'CNY',
  'EUR',
  'GBP',
  'HKD',
  'IDR',
  'INR',
  'JPY',
  'KRW',
  'LKR',
  'MXN',
  'MYR',
  'NGN',
  'NPR',
  'NZD',
  'PHP',
  'PKR',
  'RUB',
  'SAR',
  'SGD',
  'THB',
  'TRY',
  'USD',
  'VND',
  'ZAR',
]);

const CURRENCY_SIGNALS: readonly (readonly [RegExp, string])[] = [
  // Symbols — unambiguous, so they lead.
  [/R\$/i, 'BRL'],
  [/₹/, 'INR'],
  [/\$/, 'USD'],
  [/€/, 'EUR'],
  [/£/, 'GBP'],
  [/¥/, 'JPY'],
  [/₺/, 'TRY'],
  [/₩/, 'KRW'],
  [/₫/, 'VND'],
  [/฿/, 'THB'],
  [/₦/, 'NGN'],
  [/₱/, 'PHP'],
  [/₽/, 'RUB'],
  // Qualified rupee and dollar names, before the bare words below.
  [/\bsri[\s-]?lankan\s+rupees?\b|\blkr\b/i, 'LKR'],
  [/\bnepali\s+rupees?\b|\bnpr\b/i, 'NPR'],
  [/\bpakistani\s+rupees?\b|\bpkr\b/i, 'PKR'],
  [/\bcanadian\s+dollars?\b|\bcad\b/i, 'CAD'],
  [/\baustralian\s+dollars?\b|\baud\b/i, 'AUD'],
  [/\bsingapore(?:an)?\s+dollars?\b|\bsgd\b/i, 'SGD'],
  [/\bnew\s+zealand\s+dollars?\b|\bnzd\b/i, 'NZD'],
  [/\bhong\s+kong\s+dollars?\b|\bhkd\b/i, 'HKD'],
  [/\bmexican\s+pesos?\b|\bmxn\b/i, 'MXN'],
  [/\bphilippine\s+pesos?\b|\bphp\b/i, 'PHP'],
  [/\bsaudi\s+riyals?\b|\bsar\b/i, 'SAR'],
  [/\bsouth\s+african\s+rands?\b|\bzar\b/i, 'ZAR'],
  [/\bbangladeshi\s+takas?\b|\bbdt\b/i, 'BDT'],
  [/\bbrazilian\s+reais\b|\bbrazilian\s+reals?\b|\bbrl\b/i, 'BRL'],
  [/\bturkish\s+liras?\b/i, 'TRY'],
  [/\bTRY\b/, 'TRY'],
  [/\b(?:indonesian\s+)?rupiahs?\b|\bidr\b|\brp\b/i, 'IDR'],
  // Bare words.
  [/\b(?:rupees?|rupaye|rupya|rs|inr)\b/i, 'INR'],
  [/\b(?:dollars?|usd|bucks?)\b/i, 'USD'],
  [/\b(?:euros?|eur)\b/i, 'EUR'],
  [/\b(?:pounds?|sterling|quid|gbp)\b/i, 'GBP'],
  [/\b(?:dirhams?|aed)\b/i, 'AED'],
  [/\b(?:yen|jpy)\b/i, 'JPY'],
  [/\b(?:won|krw)\b/i, 'KRW'],
  [/\b(?:yuan|renminbi|rmb|cny)\b/i, 'CNY'],
  [/\b(?:ringgit|myr)\b/i, 'MYR'],
  [/\b(?:baht|thb)\b/i, 'THB'],
  [/\b(?:dong|vnd)\b/i, 'VND'],
  [/\b(?:francs?|chf)\b/i, 'CHF'],
  [/\b(?:naira|ngn)\b/i, 'NGN'],
  [/\b(?:pesos?|mxn)\b/i, 'MXN'],
  [/\b(?:riyals?|sar)\b/i, 'SAR'],
  [/\b(?:rands?|zar)\b/i, 'ZAR'],
  [/\b(?:takas?|bdt)\b/i, 'BDT'],
  [/\b(?:reais|reals?|brl)\b/i, 'BRL'],
  [/\b(?:rubles?|roubles?|rub)\b/i, 'RUB'],
];

/**
 * Every alphabetic currency word and code, longest phrases first, as one
 * alternation — the shared source for the amount-adjacency, spoken-number and
 * note-stripping patterns, so a currency added above is understood everywhere
 * at once instead of drifting between four hand-kept lists.
 */
const CURRENCY_WORD_ALT = [
  'sri[\\s-]?lankan\\s+rupees?',
  'nepali\\s+rupees?',
  'pakistani\\s+rupees?',
  'canadian\\s+dollars?',
  'australian\\s+dollars?',
  'singapore(?:an)?\\s+dollars?',
  'new\\s+zealand\\s+dollars?',
  'hong\\s+kong\\s+dollars?',
  'mexican\\s+pesos?',
  'philippine\\s+pesos?',
  'saudi\\s+riyals?',
  'south\\s+african\\s+rands?',
  'bangladeshi\\s+takas?',
  'brazilian\\s+reais',
  'brazilian\\s+reals?',
  'turkish\\s+liras?',
  'indonesian\\s+rupiahs?',
  'rupiahs?',
  'idr',
  'rp',
  'rupees?',
  'rupaye',
  'rupya',
  'rs',
  'inr',
  'dollars?',
  'usd',
  'bucks?',
  'euros?',
  'eur',
  'pounds?',
  'sterling',
  'quid',
  'gbp',
  'dirhams?',
  'aed',
  'yen',
  'jpy',
  'won',
  'krw',
  'yuan',
  'renminbi',
  'rmb',
  'cny',
  'ringgit',
  'myr',
  'baht',
  'thb',
  'dong',
  'vnd',
  'francs?',
  'chf',
  'naira',
  'ngn',
  'pesos?',
  'mxn',
  'php',
  'riyals?',
  'sar',
  'rands?',
  'zar',
  'takas?',
  'bdt',
  'reais',
  'reals?',
  'brl',
  'rubles?',
  'roubles?',
  'rub',
  'turkish\\s+liras?',
  'lkr',
  'npr',
  'pkr',
  'cad',
  'aud',
  'sgd',
  'nzd',
  'hkd',
].join('|');

/** The currency symbols, as a character-class body. */
const CURRENCY_SYMBOL_CLASS = '₹$€£¥₺₩₫฿₦₱₽';
const CURRENCY_SYMBOL_RE = `(?:R\\$|[${CURRENCY_SYMBOL_CLASS}])`;

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
  // Greetings and filler people lead with — "hello, uh, add 500 to Goa". They
  // are neither a description nor a group name, so they must not survive into the
  // note or tip a group match. Kept to clear interjections and openers; ordinary
  // words that could name a group ("so", "well", "like") are deliberately left
  // out so a real group name is never eaten.
  'hello',
  'helo',
  'hi',
  'hii',
  'hey',
  'heya',
  'hiya',
  'yo',
  'um',
  'umm',
  'uh',
  'uhh',
  'uhm',
  'er',
  'erm',
  'hmm',
  'hmmm',
  'namaste',
  'ok',
  'okay',
  'please',
  'kindly',
  // Polite-request framing people wrap a command in — "can you please add 500
  // for tea shop". None of these describe an expense or name a group, so they
  // must not survive into the note ("can you tea shop") or tip a group match.
  // Left out on purpose: words that double as common first names — "will", "may",
  // "grace" — since a 1:1 friend group is named after the person, and a name that
  // collapsed to a stopword could never be matched by voice.
  'can',
  'could',
  'would',
  'should',
  'shall',
  'you',
  'your',
  'i',
  'me',
  'want',
  'wanted',
  'wants',
  'need',
  'needs',
  'let',
  'lets',
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
  // Decimal and minor-unit words — normalisation turns "point five" and "fifty
  // paise" into digits, but any that slip through (a fraction with no currency
  // beside it) must not survive into a description or a group match.
  'point',
  'dot',
  'decimal',
  'paise',
  'paisa',
  'cent',
  'cents',
  'pence',
  'fils',
]);

/** A signed number; validation below accepts only positive values. */
const SIGNED_AMOUNT_RE = String.raw`[+-]?\s*\d[\d,]*(?:\.\d+)?`;

/** A number sitting next to a currency word or symbol — the amount, said plainly. */
const CURRENCY_ADJACENT = new RegExp(
  `${CURRENCY_SYMBOL_RE}\\s*(${SIGNED_AMOUNT_RE})|(${SIGNED_AMOUNT_RE})\\s*(?:${CURRENCY_WORD_ALT})\\b`,
  'i',
);

/**
 * A count of people to split among: "among 3", "between 4", "3 people", "3 ways".
 * Anchored to a split word or a people/ways word so the amount right after
 * "split" ("split 500 …") is never taken as the count.
 */
const SPLIT_COUNT =
  /\b(?:among|amongst|between)\s+(\d+)\b|\b(\d+)\s*(?:people|persons?|ppl|ways?|folks?|heads?)\b/i;

/** Lowercase word tokens, Unicode-normalized, punctuation and symbols stripped. */
function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** A matched numeric string to a positive, safe amount, commas removed — or null. */
function toAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseFloat(raw.replace(/,/g, '').replace(/\s+/g, ''));
  return Number.isFinite(value) && value > 0 && value <= MAX_VOICE_AMOUNT_MAJOR ? value : null;
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
  const first = withoutCount.match(new RegExp(SIGNED_AMOUNT_RE));
  return toAmount(first?.[0]);
}

/** Which currency, if any, the sentence names. First signal that fits wins. */
function detectCurrency(text: string): string | null {
  for (const [pattern, code] of CURRENCY_SIGNALS) {
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
 * A phrase that points at the contextual group rather than naming one — "this
 * group" / "current group" while already looking at one, or "the latest group",
 * "last group", "my most recent group", "previous group" from the global mic.
 * The reader's group list arrives current/most-recent-first, so a hit resolves
 * to its first entry (see `parseVoiceExpenses`). The words must sit next to
 * "group": "last Goa group" names Goa and is left for `matchGroup`, not caught
 * here.
 */
const RELATIVE_GROUP =
  /\b(?:the\s+|my\s+|that\s+)?(?:this|current|active|latest|last|recent|most\s+recent|previous|prev)\s+group\b/iu;

export function detectRelativeGroup(text: string): boolean {
  return RELATIVE_GROUP.test(text);
}

/** Lift the relative-group phrase out, so "group"/"latest" never reach a note. */
export function stripRelativeGroupPhrase(text: string): string {
  return text
    .replace(new RegExp(RELATIVE_GROUP.source, 'giu'), ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * The words left once the amount, currency and named group are taken out — the
 * description someone would have typed. Numbers, currency words, the stopwords,
 * and any word from the matched group's name are all dropped.
 */
const SPLIT_COUNT_WORD_AFTER_PREPOSITION =
  '(?:\\d|zero\\b|one\\b|two\\b|three\\b|four\\b|five\\b|six\\b|seven\\b|eight\\b|nine\\b|ten\\b|eleven\\b|twelve\\b|people\\b|persons\\b|ways\\b)';
const SPLIT_WITH_CLAUSE = new RegExp(
  `\\bsplit\\b(?:(?!\\bwith\\b|\\bbetween\\b|\\bamong\\b|\\bamongst\\b).)*` +
    `\\b(?:with|between|among|amongst)\\b\\s+(?!${SPLIT_COUNT_WORD_AFTER_PREPOSITION})(.*)$`,
  'iu',
);

function splitParticipantClause(text: string | null): string | null {
  return text?.match(SPLIT_WITH_CLAUSE)?.[1]?.trim() || null;
}

function buildNote(transcript: string, matchedGroupName: string | null): string {
  const nameTokens = new Set(matchedGroupName ? tokenize(matchedGroupName) : []);
  const currencyWord = new RegExp(`\\b(?:${CURRENCY_WORD_ALT})\\b`, 'gi');

  return transcript
    .replace(SPLIT_WITH_CLAUSE, ' ')
    .replace(currencyWord, ' ')
    .replace(new RegExp(CURRENCY_SYMBOL_RE, 'g'), ' ')
    .replace(/\d[\d,]*(?:\.\d+)?/g, ' ')
    .split(/\s+/)
    .filter((word) => {
      const token = word
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, '');
      if (!token) return false;
      if (STOPWORDS.has(token)) return false;
      if (nameTokens.has(token)) return false;
      return true;
    })
    .join(' ')
    .trim();
}

/**
 * Strip only the recognised *routing lead-in* — "assign to (group)", "put it in
 * (group)", "in this/that/another/the group", "move/save it to" — leaving the
 * destination name and the description untouched. Phrase-aware on purpose: the
 * routing verbs and pointers are not blanket stopwords, so a group literally
 * named "IT", "This" or "Group 1" still matches, and an ordinary note like
 * "for this lunch" keeps "this". The trailing "group" is only removed when a
 * word follows it (`(?=\p{L})`), so "assign to group test one" drops "group"
 * but "assign to group 1" keeps "Group 1" intact for the match.
 */
export function stripAssignmentLeadIn(text: string): string {
  return text
    .replace(
      /\b(?:assign(?:ed)?|move|save|put)\s+(?:it\s+)?(?:to|into|in)\s+(?:the\s+|this\s+|that\s+|another\s+)?(?:groups?\s+(?=\p{L}))?/giu,
      ' ',
    )
    .replace(/\bin\s+(?:this|that|another|the)\s+groups?\s+(?=\p{L})/giu, ' ')
    .replace(/[ \t]{2,}/g, ' ')
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
  if (isUnsupportedVoiceExpenseIntent(transcript)) {
    return {
      amountMinor: null,
      amountMajor: null,
      currency: null,
      note: '',
      groupId: null,
      splitCount: null,
    };
  }

  // Spoken numbers become digits first; every pattern below is digit-based. A
  // "plus"-joined run of amounts is summed into one before that. Common Hindi,
  // Tamil and Arabic amount/currency words are folded into the same vocabulary
  // before this step, so the deterministic path works offline in the app locales.
  const said = stripAssignmentLeadIn(
    normalizeSpokenNumbers(collapseAdditionRuns(normalizeVoiceInput(transcript))),
  );
  const tokens = tokenize(said);
  const amountMajor = extractAmount(said);
  const currency = detectCurrency(said);
  const amountMinor = amountMajor === null ? null : toVoiceMinorUnits(amountMajor, currency);
  const groupId = matchGroup(tokens, groups);
  const matchedName = groupId ? (groups.find((group) => group.id === groupId)?.name ?? null) : null;

  return {
    amountMinor,
    amountMajor,
    currency,
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

export function resolveVoiceParticipants(params: {
  all: readonly string[];
  payer: string;
  members: readonly { id: string; name: string }[];
  peopleText: string | null;
  splitCount: number | null;
}): string[] {
  const clause = splitParticipantClause(params.peopleText);
  const named = clause ? matchMemberNames(clause, params.members) : [];
  if (named.length === 0) return [...params.all];
  const chosen = named.includes(params.payer) ? [...named] : [...named, params.payer];
  if (params.splitCount !== null && params.splitCount !== chosen.length) return [...params.all];
  return chosen;
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

export function parseVoiceExpenseDate(text: string, now: Date = new Date()): string | null {
  if (/\bday\s+before\s+yesterday\b/i.test(text)) return localIsoDate(addDays(now, -2));
  if (/\byesterday\b/i.test(text)) return localIsoDate(addDays(now, -1));
  if (/\btomorrow\b/i.test(text)) return localIsoDate(addDays(now, 1));
  if (/\btoday\b/i.test(text)) return localIsoDate(now);

  const iso = text.match(/\b(?:on\s+)?(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (!iso) return null;
  const year = Number(iso[1]);
  const month = Number(iso[2]);
  const day = Number(iso[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return localIsoDate(date);
}

function stripDatePhrases(text: string): string {
  return text
    .replace(/\b(?:on\s+)?\d{4}-\d{1,2}-\d{1,2}\b/gi, ' ')
    .replace(/\bday\s+before\s+yesterday\b/gi, ' ')
    .replace(/\b(?:today|yesterday|tomorrow)\b/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const CATEGORY_WORDS = new Map<string, CategoryId>(
  CATEGORIES.flatMap((category) => [
    [category.id, category.id],
    [category.label.toLowerCase(), category.id],
    ...category.label
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .map((word) => [word, category.id] as const),
  ]),
);

const CATEGORY_PHRASE =
  /\b(?:category|tag|label)\s+(?:as\s+)?([\p{L}\p{N}][\p{L}\p{N}& -]{0,40}?)(?=\s+(?:and|then|with|split|on|for|to|in|into|category|tag|label)\b|\s*[,;]|\s*$)/giu;

export function parseVoiceCategory(text: string): CategoryId | null {
  CATEGORY_PHRASE.lastIndex = 0;
  for (let match = CATEGORY_PHRASE.exec(text); match !== null; match = CATEGORY_PHRASE.exec(text)) {
    const phrase = match[1].trim().toLowerCase();
    if (!phrase) continue;
    const category = CATEGORY_WORDS.get(phrase);
    if (category) return category;
  }
  return null;
}

function stripCategoryPhrase(text: string): string {
  CATEGORY_PHRASE.lastIndex = 0;
  return text
    .replace(CATEGORY_PHRASE, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/* ─────────────────────────────────────────────────────────────────────────
 * Several expenses in one breath, an optional "make a group", and a nudge
 * toward other languages.
 *
 * The single-expense parser above is the certain core. This layer sits on top
 * for the fuller request: "five rupees for snacks, ten for tea, shopping 1000"
 * is four expenses, not one; "make a group called Goa and add 500" both creates
 * a group and files an expense into it. None of it needs a model or a network —
 * this pure heuristic is the whole of voice parsing.
 * ───────────────────────────────────────────────────────────────────────── */

/** One expense lifted out of a possibly-multi sentence. Always has an amount. */
export interface VoiceExpenseItem {
  amountMinor: bigint;
  amountMajor: number;
  currency: string | null;
  note: string;
  category: CategoryId | null;
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
  /** The cleaned transcript fragment that may name split participants. */
  peopleText: string | null;
  /** A deterministic spoken expense date, when one was heard. */
  expenseDate: string | null;
  /**
   * The spend is the speaker's own ("just for me"), so the screen routes the
   * batch to the private "Me" ledger (A48) instead of a group. Only ever true
   * when no group was named — an explicit group wins over a solo marker.
   */
  personal: boolean;
}

/**
 * When a spoken sentence is unambiguous enough to act on without a review, the
 * action to take — otherwise null and the screen shows the editable review.
 *
 * Two cases are safe to act on directly:
 *  - `create-group`: a bare "make a group called Goa" with no expense in it. No
 *    amount to mishear, nothing to split — just the group.
 *  - `commit-expense`: exactly one *plain* expense aimed at a group that already
 *    exists. The group's own currency and an equal split are the documented
 *    defaults the review would have applied anyway, so there is nothing a tap
 *    would decide.
 *
 * Everything else — several expenses in a breath, a group to *create* alongside
 * an expense, a "just for me" spend, an unresolved or unnamed destination, or a
 * command carrying split/date/category details — returns null so the reader
 * confirms on the review screen first.
 */
export type VoiceAutoAction =
  { kind: 'create-group'; name: string } | { kind: 'commit-expense'; groupId: string };

export function voiceAutoAction(result: VoiceParseResult): VoiceAutoAction | null {
  if (
    result.group?.kind === 'create' &&
    result.items.length === 0 &&
    result.group.name.trim().length > 0
  ) {
    return { kind: 'create-group', name: result.group.name };
  }

  const [item] = result.items;
  const hasSplitInstructions =
    result.splitCount !== null || splitParticipantClause(result.peopleText) !== null;
  const hasNonDefaultExpenseFields = result.expenseDate !== null || item?.category !== null;

  if (
    result.group?.kind === 'existing' &&
    !result.personal &&
    result.items.length === 1 &&
    !hasSplitInstructions &&
    !hasNonDefaultExpenseFields &&
    item &&
    Number.isFinite(item.amountMajor) &&
    item.amountMajor > 0
  ) {
    return { kind: 'commit-expense', groupId: result.group.groupId };
  }

  return null;
}

/**
 * A spoken money-movement command that is not an expense: settling a debt or
 * reminding someone to pay. The verb and the person's name are pulled out here;
 * the screen resolves the name against the reader's people and reads the amount
 * and direction from the balance (see voice.tsx). `amount` is a spoken partial
 * for a settle ("settle 200 with Ravi"); null means settle the whole balance.
 *
 * Only explicit settle/remind verbs fire this — bare "pay"/"paid" stay expenses,
 * so "I paid 500 for dinner" is untouched. A verb with no name returns null so
 * the sentence falls through to the ordinary expense parse.
 */
export type VoiceMoneyIntent =
  { kind: 'settle'; who: string; amount: number | null } | { kind: 'remind'; who: string };

const REMIND_VERB = /\b(?:remind|nudge|send\s+(?:a\s+)?(?:payment\s+)?reminder\s+to)\b\s*/i;
const SETTLE_VERB =
  /\b(?:settle\s*up|settle|pay\s*back|pay\s*off|clear\s*up|clear\s+(?:the\s+)?(?:balance|dues?))\b\s*/i;
const MARK_SETTLED = /\bmark\s+(.+?)\s+as\s+settled\b/iu;
const NON_PERSON_REMINDER = /^\s*(?:me|myself|us|ourselves)\b/iu;
const NON_PERSON_SETTLEMENT = /\b(?:bill|receipt|expense|hotel|restaurant|tab)\b/iu;
const GENERIC_PERSON_TARGET = /^(?:everyone|everybody|all|all friends|friends|group|the group)$/iu;
const NON_MEMBER_DESTINATION =
  /\b(?:grocery|shopping|packing|todo|to-do|checklist|list|plan|itinerary|agenda)\b/iu;

function isGenericPersonTarget(text: string): boolean {
  return GENERIC_PERSON_TARGET.test(text.trim());
}

/** The person's name out of a settle/remind clause — the words a name is made
 *  of, once the amount, currency and command filler are taken away. Prefers an
 *  explicit "with X" tail; the screen's name matcher does the rest. */
function cleanWho(text: string): string {
  const withClause = text.match(/\bwith\s+(.+)$/iu);
  return (withClause ? withClause[1] : text)
    .replace(/\d[\d.,]*/g, ' ')
    .replace(
      /\b(?:up|to|for|my|me|the|a|an|friend|friends|back|off|pay|paid|paying|settle|settled|remind|nudge|now|please|today|tomorrow|tonight|later|rupees?|rupee|dollars?|dollar|euros?|euro|about|it|money|balance|dues?|owed?|owes)\b/giu,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanInviteName(name: string): string {
  return name
    .replace(/^\s*and\s+/iu, '')
    .replace(/^\s*(?:(?:the|a|an|my|all)\s+)?(?:friend|friends|person|people)\s+/iu, '')
    .trim();
}

export function detectMoneyIntent(transcript: string): VoiceMoneyIntent | null {
  const norm = normalizeSpokenNumbers(collapseAdditionRuns(normalizeVoiceInput(transcript)));

  const remind = norm.match(REMIND_VERB);
  if (remind && remind.index !== undefined) {
    const rest = norm.slice(remind.index + remind[0].length);
    if (NON_PERSON_REMINDER.test(rest)) return null;
    const who = cleanWho(rest);
    if (who && !isGenericPersonTarget(who)) return { kind: 'remind', who };
  }

  const markedSettled = norm.match(MARK_SETTLED);
  if (markedSettled) {
    const who = cleanWho(markedSettled[1]);
    if (who && !isGenericPersonTarget(who)) return { kind: 'settle', who, amount: null };
  }

  const settle = norm.match(SETTLE_VERB);
  if (settle && settle.index !== undefined) {
    const rest = norm.slice(settle.index + settle[0].length);
    if (!/\bwith\b/iu.test(rest) && NON_PERSON_SETTLEMENT.test(rest)) return null;
    const who = cleanWho(rest);
    if (who && !isGenericPersonTarget(who))
      return { kind: 'settle', who, amount: extractAmount(rest) };
  }

  return null;
}

/**
 * A spoken "add someone to a group" — "add Ravi to the latest group", "include
 * Priya and Sam in Goa". One or more names between the verb and the "to/into/in
 * <group>" tail. The screen resolves the group (a named or relative one, via the
 * ordinary parse) and adds a ghost per name.
 *
 * Guarded against the expense it looks like: a sentence with an amount is "add
 * 500 to Goa", not a member add, so any number here returns null and the
 * sentence stays an expense. A verb with no name, a non-group destination such
 * as a shopping list, or no "to/into/in" tail returns null too. The group is NOT
 * resolved here — the caller does that and falls back to the expense parse when
 * nothing resolves.
 */
export function detectAddMember(transcript: string): { names: string[] } | null {
  const norm = normalizeSpokenNumbers(collapseAdditionRuns(normalizeVoiceInput(transcript)));
  if (extractAmount(norm) !== null) return null;

  const match = norm.match(/\b(?:add|include|put|invite)\s+(.+?)\s+(?:to|into|in)\b\s+(.+)$/iu);
  if (!match || NON_MEMBER_DESTINATION.test(match[2])) return null;

  const names = match[1]
    .replace(/^\s*(?:the|a|an|my)\s+/iu, '')
    .split(/\s*,\s*|\s+and\s+|\s*&\s*/iu)
    .map(cleanInviteName)
    .filter((name) => name && !isGenericPersonTarget(name));
  return names.length > 0 ? { names } : null;
}

/**
 * A spoken read-only question about balances — "how much does Ravi owe me",
 * "what's my balance in Goa", "am I settled with Priya". Nothing is written; the
 * screen looks the number up and shows it. `person` carries the name to resolve;
 * `balance` is a group/overall question the screen answers by resolving the
 * group named (and shows nothing when none resolves — it is not a command).
 *
 * A person frame ("does X owe", "I owe X", "settled with X") wins; failing that,
 * a first-person balance question with no name is a `balance`. Anything without
 * a balance word, or without a question framing, returns null so an ordinary
 * expense is never mistaken for a question.
 */
export type VoiceBalanceQuery = { kind: 'person'; who: string } | { kind: 'balance' };

// Frames that name a specific person. The "I owe X" ones lead so "how much do I
// owe Priya" reads Priya, not "I"; the third-person one then excludes "i" as the
// subject so it only catches "how much does Ravi owe".
const QUERY_PERSON_FRAMES: readonly RegExp[] = [
  /\b(?:how much do i owe|what do i owe|do i owe)\s+(.+)$/iu,
  /\bhow much (?:does|do)\s+(?!i\b)(.+?)\s+owe\b/iu,
  /\bdoes\s+(.+?)\s+owe\s+me\b/iu,
  /\b(?:balance|settled(?:\s+up)?)\s+with\s+(.+)$/iu,
];

// Words a person is not — "how much do I owe overall" is a balance question,
// not a debt to someone named "overall". Stripped from a captured name; when
// nothing is left, the frame did not really name a person.
const QUERY_NON_PERSON = /\b(?:overall|in total|total|everyone|everybody|anyone|anybody|all)\b/giu;

export function detectBalanceQuery(transcript: string): VoiceBalanceQuery | null {
  const norm = normalizeSpokenNumbers(collapseAdditionRuns(normalizeVoiceInput(transcript)));

  for (const frame of QUERY_PERSON_FRAMES) {
    const match = norm.match(frame);
    if (match) {
      const who = cleanWho(match[1]).replace(QUERY_NON_PERSON, ' ').replace(/\s+/g, ' ').trim();
      if (who) return { kind: 'person', who };
    }
  }

  const framed = /\b(?:how much|what(?:'s| is)?|do i|am i|are we)\b/iu.test(norm);
  const aboutBalance = /\b(?:balance|owe|owed|owes|settled)\b/iu.test(norm);
  if (framed && aboutBalance) return { kind: 'balance' };

  return null;
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

function normalizeCurrencyPrefixes(text: string): string {
  return text.replace(/\b(rp|idr)\.?\s*(?=\d)/gi, '$1 ');
}

/**
 * Localized number and currency words from the app's non-English locales, folded
 * into the English vocabulary the parser already understands. This is deliberately
 * a small deterministic bridge, not a translation system: the model remains the
 * broad answer for arbitrary language, while common Hindi/Tamil/Arabic amount
 * commands work even offline.
 */
const LOCALIZED_VOICE_WORDS: ReadonlyMap<string, string> = new Map([
  // Hindi currency and common amount words.
  ['रुपये', 'rupees'],
  ['रुपया', 'rupees'],
  ['रुपए', 'rupees'],
  ['रूपये', 'rupees'],
  ['रूपया', 'rupees'],
  ['रूपए', 'rupees'],
  ['पैसे', 'paise'],
  ['पैसा', 'paise'],
  ['शून्य', 'zero'],
  ['एक', 'one'],
  ['दो', 'two'],
  ['तीन', 'three'],
  ['चार', 'four'],
  ['पांच', 'five'],
  ['पाँच', 'five'],
  ['छह', 'six'],
  ['सात', 'seven'],
  ['आठ', 'eight'],
  ['नौ', 'nine'],
  ['दस', 'ten'],
  ['बीस', 'twenty'],
  ['तीस', 'thirty'],
  ['चालीस', 'forty'],
  ['पचास', 'fifty'],
  ['साठ', 'sixty'],
  ['सत्तर', 'seventy'],
  ['अस्सी', 'eighty'],
  ['नब्बे', 'ninety'],
  ['सौ', 'hundred'],
  ['हजार', 'thousand'],
  ['लाख', 'lakh'],
  ['करोड़', 'crore'],
  // Tamil currency and common amount words.
  ['ரூபாய்', 'rupees'],
  ['ரூபாய்கள்', 'rupees'],
  ['பைசா', 'paise'],
  ['பைசே', 'paise'],
  ['பூஜ்யம்', 'zero'],
  ['ஒன்று', 'one'],
  ['இரண்டு', 'two'],
  ['மூன்று', 'three'],
  ['நான்கு', 'four'],
  ['ஐந்து', 'five'],
  ['ஆறு', 'six'],
  ['ஏழு', 'seven'],
  ['எட்டு', 'eight'],
  ['ஒன்பது', 'nine'],
  ['பத்து', 'ten'],
  ['இருபது', 'twenty'],
  ['முப்பது', 'thirty'],
  ['நாற்பது', 'forty'],
  ['ஐம்பது', 'fifty'],
  ['அறுபது', 'sixty'],
  ['எழுபது', 'seventy'],
  ['எண்பது', 'eighty'],
  ['தொண்ணூறு', 'ninety'],
  ['நூறு', 'hundred'],
  ['ஆயிரம்', 'thousand'],
  ['லட்சம்', 'lakh'],
  ['கோடி', 'crore'],
  // Arabic currency and common amount words.
  ['روبية', 'rupees'],
  ['روبيات', 'rupees'],
  ['روبيه', 'rupees'],
  ['روبي', 'rupees'],
  ['درهم', 'dirhams'],
  ['دراهم', 'dirhams'],
  ['فلس', 'fils'],
  ['فلوس', 'fils'],
  ['صفر', 'zero'],
  ['واحد', 'one'],
  ['واحدة', 'one'],
  ['اثنان', 'two'],
  ['اثنين', 'two'],
  ['اثنتان', 'two'],
  ['اثنتين', 'two'],
  ['ثلاثة', 'three'],
  ['ثلاث', 'three'],
  ['أربعة', 'four'],
  ['اربعة', 'four'],
  ['أربع', 'four'],
  ['اربع', 'four'],
  ['خمسة', 'five'],
  ['خمس', 'five'],
  ['ستة', 'six'],
  ['ست', 'six'],
  ['سبعة', 'seven'],
  ['سبع', 'seven'],
  ['ثمانية', 'eight'],
  ['ثمان', 'eight'],
  ['تسعة', 'nine'],
  ['تسع', 'nine'],
  ['عشرة', 'ten'],
  ['عشر', 'ten'],
  ['عشرون', 'twenty'],
  ['ثلاثون', 'thirty'],
  ['أربعون', 'forty'],
  ['اربعون', 'forty'],
  ['خمسون', 'fifty'],
  ['ستون', 'sixty'],
  ['سبعون', 'seventy'],
  ['ثمانون', 'eighty'],
  ['تسعون', 'ninety'],
  ['مئة', 'hundred'],
  ['مائة', 'hundred'],
  ['ألف', 'thousand'],
  ['الف', 'thousand'],
  ['مليون', 'million'],
]);

function normalizeLocalizedVoiceWords(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s+$/u.test(part)) return part;
      // A token often carries leading/trailing punctuation — a comma, the Arabic
      // comma (،), a Devanagari danda (।), a full stop — as in "रुपये," or
      // "روبية،". Split that off, translate the bare word, then restore the
      // punctuation, so the currency/number word is still recognised (an exact
      // lookup of "रुपये," would miss and leave the token untranslated).
      const match = /^([\p{P}\p{S}]*)(.*?)([\p{P}\p{S}]*)$/u.exec(part);
      if (!match) return part;
      const [, prefix, core, suffix] = match;
      if (!core) return part;
      const replacement = LOCALIZED_VOICE_WORDS.get(core.normalize('NFKC'));
      return replacement ? `${prefix}${replacement}${suffix}` : part;
    })
    .join('');
}

function normalizeVoiceInput(text: string): string {
  return normalizeLocalizedVoiceWords(normalizeCurrencyPrefixes(normalizeDigits(text)));
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

/**
 * Spoken zero-fillers a person says inside a digit-by-digit amount: "two oh
 * five" (₹205), "two naught five". Speech-to-text often writes the spoken
 * "naught" as "not", so that spelling is handled too — but only inside a run,
 * never as a standalone word (see {@link spokenDigitSequence}); "not" is an
 * ordinary negation and must never mint a number on its own. Kept apart from
 * {@link NUMBER_WORDS} so the compositional adder never sums them as a value.
 */
const SPOKEN_ZERO: ReadonlyMap<string, number> = new Map([
  ['naught', 0],
  ['nought', 0],
  ['oh', 0],
  ['o', 0],
]);

/**
 * Any single word that can appear inside a spoken number. The zero-fillers and
 * "not" are included so a digit-by-digit run stays whole ("two oh five", "two
 * not five") for the callback to read; the callback, not the regex, decides
 * whether "not" is really a zero.
 */
const NUMBER_WORD_RE = [
  ...NUMBER_WORDS.keys(),
  ...NUMBER_MULTIPLIERS.keys(),
  ...SPOKEN_ZERO.keys(),
  'not',
].join('|');

/** A digit group inside a spoken run: "3", "3,000", "3.5". */
const DIGIT_VALUE_RE = String.raw`\d[\d,]*(?:\.\d+)?`;

/** One value in a run — a digit group or a number word — so "3 thousand" reads as one. */
const NUMBER_VALUE_RE = `(?:${DIGIT_VALUE_RE}|${NUMBER_WORD_RE})`;

/** Test for a lone digit token (used to tell "3 thousand" from bare "5 10"). */
const DIGIT_TOKEN = new RegExp(`^${DIGIT_VALUE_RE}$`);

/** Words that introduce a decimal fraction in speech: "point five", "dot five". */
const DECIMAL_WORD_RE = 'point|dot|decimal';

/** A spoken decimal tail — the "point five zero" after a whole number. */
const DECIMAL_TAIL_RE = `(?:[\\s-]+(?:${DECIMAL_WORD_RE})(?:[\\s-]+${NUMBER_VALUE_RE})+)`;

/** True when a run carries a spoken decimal marker. */
const HAS_DECIMAL = new RegExp(`\\b(?:${DECIMAL_WORD_RE})\\b`, 'i');

/**
 * A run of numbers, joined by spaces, hyphens or a linking "and", with an
 * optional spoken decimal tail ("hundred point five"). Digits are allowed
 * alongside words because dictation mixes them — "3 thousand", "5 lakh" — and
 * those must fold to one amount, not split into two. The second alternative
 * catches a bare fraction with no whole part ("point five"), which the callback
 * only rewrites when it sits against money.
 */
const SPOKEN_NUMBER = new RegExp(
  `\\b${NUMBER_VALUE_RE}(?:[\\s-]+(?:and[\\s-]+)?${NUMBER_VALUE_RE})*${DECIMAL_TAIL_RE}?\\b` +
    `|\\b(?:${DECIMAL_WORD_RE})(?:[\\s-]+${NUMBER_VALUE_RE})+\\b`,
  'gi',
);

/**
 * A currency word or symbol — the signal that a nearby number is money.
 *
 * The alphabetic words carry word boundaries so a short token like "rs" cannot
 * match inside an ordinary word ("person" → "pe-rs-on"): without them "one
 * person paid" would read "rs" as currency and mint a false amount.
 */
const CURRENCY_TOKEN = new RegExp(`(?:${CURRENCY_SYMBOL_RE}|\\b(?:${CURRENCY_WORD_ALT})\\b)`, 'i');

/**
 * A currency word or symbol *immediately* after a number — anchored at the start
 * of the following text. Whole-name (CURRENCY_WORD_ALT is longest-first), so a
 * three-word name like "sri lankan rupees" or "new zealand dollars" is caught
 * where a fixed two-word window would clip it and miss the currency signal. The
 * anchor keeps it to true adjacency, so a currency word later in the sentence
 * ("five hundred for dinner, 20 rupees") does not make the earlier run money.
 */
const CURRENCY_AT_START = new RegExp(`^(?:${CURRENCY_SYMBOL_RE}|(?:${CURRENCY_WORD_ALT})\\b)`, 'i');

/** Split-phrase context — a number here is a people count, still worth digitising. */
const SPLIT_BEFORE_WORD = /^(?:among|amongst|between)$/i;
const SPLIT_AFTER_WORD = /^(?:people|persons?|ppl|ways?|folks?|heads?)\b/i;

/** A minor-unit word ("fifty paise", "ninety nine cents") — the number before it is money. */
const MINOR_UNIT_AFTER = /^(?:paise|paisa|cents?|pence|fils)\b/i;

/**
 * Fold a spoken minor amount into the major one: "100 rupees 50 paise" →
 * "100.50 rupees", "20 dollars 99 cents" → "20.99 dollars". Runs after the
 * spoken numbers are digits, so both parts are already numeric. The minor part
 * is padded to two places ("5 paise" is 0.05, not 0.5) and the currency word is
 * kept so {@link detectCurrency} still reads it.
 */
function foldMinorUnits(text: string): string {
  // The shared currency alternation, so a qualified name ("Canadian dollars")
  // folds its cents too — a hand-kept subset here dropped the qualifier and lost
  // the 0.99 on "20 Canadian dollars 99 cents". The whole phrase is captured and
  // kept so detectCurrency still reads CAD, not a bare USD "dollars".
  const minorWord = '(?:paise|paisa|cents?|pence|fils)';
  const pattern = new RegExp(
    `(\\d[\\d,]*)\\s+(${CURRENCY_WORD_ALT})\\s+(?:and\\s+)?(\\d{1,2})\\s+${minorWord}\\b`,
    'gi',
  );
  return text.replace(
    pattern,
    (_match, major: string, currency: string, minor: string) =>
      `${major.replace(/,/g, '')}.${minor.padStart(2, '0')} ${currency}`,
  );
}

/**
 * Add up one run of number words: "five hundred and fifty" → 550, "hundred
 * point five" → 100.5.
 *
 * Two modes, split by a spoken decimal word. Before it, the ordinary
 * whole-number arithmetic (units add, a multiplier scales the current chunk, a
 * "group" multiplier like thousand banks it). After it, every value is read as
 * its own fraction digit — "point five zero" is ".50", not ".fifty" — because
 * that is how people speak the part after a decimal.
 */
function spokenRunToNumber(run: string): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  let fraction: string | null = null; // non-null once a decimal word is passed

  for (const word of run.toLowerCase().split(/[\s-]+/)) {
    if (!word || word === 'and') continue;

    // A stray zero-filler or a spoken-zero "not" that reached the compositional
    // path (a run with a tens word or a multiplier, so it is not a pure digit
    // string) is ignored rather than nulling the whole run — "not five hundred"
    // still reads 500, as it did before "not" was allowed to hold a run together.
    if (word === 'not' || SPOKEN_ZERO.has(word)) continue;

    if (word === 'point' || word === 'dot' || word === 'decimal') {
      // Close the whole-number part; everything after is fraction digits.
      total += current;
      current = 0;
      fraction = '';
      seen = true;
      continue;
    }

    if (fraction !== null) {
      // Fraction digits, each value contributing its own digit(s). A multiplier
      // here ("point five hundred") is not real speech — bail so the run is left
      // as spoken rather than turned into a wrong number.
      if (DIGIT_TOKEN.test(word)) {
        fraction += String(Number.parseInt(word.replace(/,/g, ''), 10));
      } else {
        const unit = NUMBER_WORDS.get(word);
        if (unit === undefined) return null;
        fraction += String(unit);
      }
      seen = true;
      continue;
    }

    // A spoken digit ("3" in "3 thousand") counts as the current chunk, so the
    // multiplier that follows scales it.
    if (DIGIT_TOKEN.test(word)) {
      current += Number.parseFloat(word.replace(/,/g, ''));
      seen = true;
      continue;
    }
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

  let value = total + current;
  if (fraction) value += Number.parseFloat(`0.${fraction}`);
  return seen && value > 0 ? value : null;
}

/** A word that can be one digit of a spoken digit-string: a 0–9 word or a zero-filler. */
function isSingleDigitWord(word: string): boolean {
  const unit = NUMBER_WORDS.get(word);
  if (unit !== undefined) return unit <= 9;
  return SPOKEN_ZERO.has(word);
}

/**
 * Read a run as a string of individual digits, the way an Indian-English speaker
 * dictates an amount: "two oh five" → "205", "two five" → "25". This is the
 * digit-sequence reading, distinct from the compositional arithmetic in
 * {@link spokenRunToNumber} ("twenty five" → 25, "two hundred five" → 205).
 *
 * It applies only when every word is a single digit (0–9), a spoken zero ("oh",
 * "naught"), or a "not" that speech-to-text wrote for a spoken zero. A tens word
 * (twenty…ninety), a multiplier (hundred, lakh…), a decimal or a bare digit
 * token all mean the run is compositional, so this returns null and the caller
 * falls back to {@link spokenRunToNumber}.
 *
 * "not" is the dangerous one — an ordinary negation, not a number. It is read as
 * a zero only when it sits *inside* the run, flanked on both sides by number
 * words, and only when the run is money-adjacent (`moneyAdjacent`), so a plain
 * "I did not pay 500" can never fold a phantom 0 into an amount.
 */
function spokenDigitSequence(words: readonly string[], moneyAdjacent: boolean): string | null {
  let digits = '';
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const unit = NUMBER_WORDS.get(word);
    if (unit !== undefined) {
      if (unit > 9) return null; // a tens/teens word — this run is compositional
      digits += String(unit);
      continue;
    }
    if (SPOKEN_ZERO.has(word)) {
      digits += '0';
      continue;
    }
    if (word === 'not') {
      const flanked = digits.length > 0 && i + 1 < words.length && isSingleDigitWord(words[i + 1]);
      if (!flanked || !moneyAdjacent) return null;
      digits += '0';
      continue;
    }
    return null; // a digit token, multiplier or decimal word — not a pure digit run
  }
  return digits.length > 0 ? digits : null;
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
  const digitised = text.replace(SPOKEN_NUMBER, (run, offset: number, whole: string) => {
    const words = run
      .toLowerCase()
      .split(/[\s-]+/)
      .filter((w: string) => w && w !== 'and');
    const hasMultiplier = words.some((w: string) => NUMBER_MULTIPLIERS.has(w));
    const hasDigit = words.some((w: string) => DIGIT_TOKEN.test(w));
    const hasDecimal = HAS_DECIMAL.test(run);
    // A run that already carries a bare digit but no scale word and no decimal is
    // left exactly as spoken: "5 10" is two amounts (two expenses), not fifteen,
    // and a lone "3000" is already a number. Only a digit joined to a scale word
    // ("3 thousand", "5 lakh") or a spoken decimal ("100 point five") is folded.
    if (hasDigit && !hasMultiplier && !hasDecimal) return run;
    const after = whole.slice(offset + run.length).trimStart();
    const before = whole.slice(0, offset).trimEnd();
    const prevWord = before.split(/\s+/).pop() ?? '';
    // Whole currency name right after the run, so a three-word qualified name
    // ("sri lankan rupees", "new zealand dollars") reads as currency where a
    // fixed two-word window clipped it and let the spoken amount slip through
    // unconverted. Anchored, so only true adjacency counts.
    const nextIsCurrency = CURRENCY_AT_START.test(after);
    const prevIsCurrency = CURRENCY_TOKEN.test(prevWord);
    const nextIsMinor = MINOR_UNIT_AFTER.test(after);
    const splitContext = SPLIT_BEFORE_WORD.test(prevWord) || SPLIT_AFTER_WORD.test(after);
    if (!hasMultiplier && !nextIsCurrency && !prevIsCurrency && !splitContext && !nextIsMinor) {
      return run;
    }
    // A money-adjacent run of only single digits ("two oh five", "two not five")
    // is a digit-string an Indian-English speaker spelled out — read it as the
    // concatenated digits, not the sum {@link spokenRunToNumber} would give.
    // "not" is treated as a spoken zero only against currency, never a split count.
    const moneyForNot = nextIsCurrency || prevIsCurrency || nextIsMinor;
    const digitSeq = spokenDigitSequence(words, moneyForNot);
    if (digitSeq !== null) return digitSeq;
    const value = spokenRunToNumber(run);
    return value === null ? run : String(value);
  });
  // Now that both parts are digits, fold a spoken minor amount ("… 50 paise")
  // into the major one.
  return foldMinorUnits(digitised);
}

/** A minor-unit word, for reading "… fifty paise" as part of an addition term. */
const MINOR_UNIT_WORD_RE = '(?:paise|paisa|cents?|pence|fils)';

/**
 * One amount in an addition run: a spoken/written number (with an optional
 * decimal tail), an optional currency word, and an optional spoken minor tail
 * ("five rupees fifty paise"). Deliberately stops at description words, so a
 * term is only ever an amount — "for tea" is never swallowed.
 */
const ADDITION_TERM_RE =
  `${NUMBER_VALUE_RE}(?:[\\s-]+(?:and[\\s-]+)?${NUMBER_VALUE_RE})*${DECIMAL_TAIL_RE}?` +
  `(?:[\\s-]+(?:${CURRENCY_WORD_ALT})\\b)?` +
  `(?:[\\s-]+(?:and[\\s-]+)?${NUMBER_VALUE_RE}[\\s-]+${MINOR_UNIT_WORD_RE}\\b)?`;

/** The explicit "add these up" signal between two amounts: the word "plus" or a "+". */
const ADDITION_CONNECTIVE_RE = String.raw`\s*(?:\bplus\b|\+)\s*`;

/**
 * A run of amounts to sum into one: a first amount, one or more "plus"/"+"-joined
 * amounts, then any number of comma-continued *bare* amounts. The comma tail only
 * extends the sum while each piece is a bare amount followed by another comma, a
 * "plus", or the end — a comma piece that carries a description ("… , 10 for tea")
 * is left for the ordinary multi-expense split, so distinct items stay distinct.
 */
const ADDITION_RUN_RE = new RegExp(
  `\\b(?:${ADDITION_TERM_RE})(?:${ADDITION_CONNECTIVE_RE}(?:${ADDITION_TERM_RE}))+` +
    `(?:\\s*,\\s*(?:${ADDITION_TERM_RE})(?=\\s*(?:,|\\+|\\bplus\\b|$)))*`,
  'gi',
);

/** Split an addition run into its terms, on "plus"/"+" or a comma. */
const ADDITION_SPLIT_RE = /\s*(?:\bplus\b|\+)\s*|\s*,\s*/i;

/** Any currency symbol or word — to find a run's primary currency and re-emit it. */
const CURRENCY_ANY_RE = new RegExp(`${CURRENCY_SYMBOL_RE}|\\b(?:${CURRENCY_WORD_ALT})\\b`, 'i');

/** A minor-unit total back to a major string, exact for the currency's own scale. */
function minorToMajorString(minor: bigint, scale: number): string {
  if (scale <= 1) return minor.toString();
  const scaleBig = BigInt(Math.round(scale));
  const whole = minor / scaleBig;
  const rem = minor % scaleBig;
  if (rem === 0n) return whole.toString();
  const fracDigits = String(scale).length - 1;
  return `${whole}.${rem.toString().padStart(fracDigits, '0')}`;
}

/**
 * Add up one "plus"-joined run into a single amount, or null to leave it be.
 *
 * The sum is done in minor units, currency-aware (so JPY is not inflated and a
 * paise/cents tail lands in the right place), to avoid float drift. A run's
 * primary currency is the first one it names; every term is read in that
 * currency, and a term that carries a *different* currency makes the whole run
 * bail (no cross-currency conversion is invented) — the sentence then keeps its
 * existing, well-tested multi-expense behaviour. The primary currency word is
 * re-emitted so downstream currency detection still reads it.
 */
function sumAdditionRun(run: string): string | null {
  const terms = run
    .split(ADDITION_SPLIT_RE)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length < 2) return null;

  let primaryText: string | null = null;
  for (const term of terms) {
    const match = term.match(CURRENCY_ANY_RE);
    if (match) {
      primaryText = match[0];
      break;
    }
  }
  const primaryCode = primaryText ? detectCurrency(primaryText) : null;

  let totalMinor = 0n;
  for (const term of terms) {
    // A term that names its own currency must match the run's; a differing one
    // means this is not a single-currency sum, so leave the run untouched.
    const ownCode = detectCurrency(term);
    if (ownCode && primaryCode && ownCode !== primaryCode) return null;
    // A bare term ("sixty") is read in the run's currency, so its decimals and
    // minor units scale the same as the terms that named one.
    const hasOwnCurrency = CURRENCY_ANY_RE.test(term);
    const forNorm = hasOwnCurrency || !primaryText ? term : `${term} ${primaryText}`;
    const major = extractAmount(normalizeSpokenNumbers(forNorm));
    if (major === null) return null;
    totalMinor += toVoiceMinorUnits(major, primaryCode);
  }

  const scale =
    primaryCode && isCurrencyCode(primaryCode) ? Number(minorUnitScale(primaryCode)) : 100;
  const major = minorToMajorString(totalMinor, scale);
  return primaryText ? `${major} ${primaryText}` : major;
}

/**
 * Collapse every "plus"/"+"-joined run of amounts into one summed amount, so a
 * dictated "twenty rupees plus fifty rupees plus five rupees" becomes one
 * ₹75 expense rather than three. Runs with no "plus" are untouched, so ordinary
 * comma/"and"-separated items ("5 for snacks, 10 for tea") stay separate
 * expenses, and the compositional "and" ("five hundred and fifty") is unaffected.
 */
export function collapseAdditionRuns(text: string): string {
  return text.replace(ADDITION_RUN_RE, (match) => sumAdditionRun(match) ?? match);
}

/**
 * A spoken "make a group" and the name it gives.
 *
 * Matches "create/make/start/new/open [a] [new] group [called/named/for] X",
 * where X runs to the first joining word ("and", "then", ",") or the end.
 * Returns the trimmed name and the sentence with that whole clause cut out, so
 * what remains can still be parsed for expenses ("make a group Goa and add 500
 * for lunch" leaves "add 500 for lunch"). Null when no such intent is heard.
 */
export function detectCreateGroup(transcript: string): { name: string; rest: string } | null {
  const pattern =
    /\b(?:create|make|start|open|add|new)\s+(?:a\s+)?(?:new\s+)?group\s+(?:called|named|for|titled|as|:)?\s*/i;
  const head = transcript.match(pattern);
  if (!head || head.index === undefined) return null;

  const after = transcript.slice(head.index + head[0].length);
  // The name is everything up to a joining word that starts the next clause, or
  // the end. "with" is allowed inside names ("Friends with Kids").
  const nameMatch = after.match(/^(.*?)(?:\s+(?:and|then|plus|also)\b|\s*[,;]|$)/i);
  const name = (nameMatch?.[1] ?? after).trim().replace(/[.\s]+$/, '');
  if (!name) return null;
  // A name that opens with a joining word is not a name: "create a group and add
  // 100" names nothing. Treat the clause as missing so the rest parses normally.
  if (/^(?:and|then|plus|also)\b/i.test(name)) return null;

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

  // A separator only starts a new expense when a *price* follows it: "5 snacks
  // and 10 tea" is two, but "bread and tea 300" is one bill whose note happens
  // to contain "and". So an amountless fragment is not its own expense — it is
  // words belonging to a neighbouring priced one. Fold each into the next priced
  // fragment (a leading label like "bread and…"); any left over at the end joins
  // the last priced fragment ("…300 and tax"). A wholly amountless transcript
  // keeps its single fragment, which the caller then drops for having no amount.
  const hasAmount = (piece: string): boolean => /\d[\d,]*(?:\.\d+)?/.test(piece);
  const merged: string[] = [];
  let pending = '';
  for (const piece of bySeparator) {
    if (hasAmount(piece)) {
      merged.push(pending ? `${pending} ${piece}` : piece);
      pending = '';
    } else {
      pending = pending ? `${pending} ${piece}` : piece;
    }
  }
  if (pending) {
    if (merged.length > 0) merged[merged.length - 1] = `${merged[merged.length - 1]} ${pending}`;
    else merged.push(pending);
  }

  const pieces: string[] = [];
  const amountRe = /\d[\d,]*(?:\.\d+)?/g;
  for (const piece of merged) {
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
 * Pure and model-free: the whole of voice parsing, no network required.
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
  if (UNSUPPORTED_GLOBAL_EXPENSE_INTENT.test(transcript))
    return {
      items: [],
      group: null,
      splitCount: null,
      peopleText: null,
      expenseDate: null,
      personal: false,
    };

  const normalized = normalizeSpokenNumbers(collapseAdditionRuns(normalizeVoiceInput(transcript)));
  const expenseDate = parseVoiceExpenseDate(normalized);
  const category = parseVoiceCategory(normalized);
  const created = detectCreateGroup(normalized);
  // Strip the routing lead-in ("assign to group …", "put it in …") after any
  // create-group clause is lifted, so the destination name and the notes are
  // read from the clean remainder.
  let body = stripDatePhrases(stripAssignmentLeadIn(created ? created.rest : normalized));

  // The group is settled before the notes are built, so each note can have the
  // named group's words taken out ("dinner on the Goa trip" → note "dinner").
  let group: VoiceGroupTarget = null;
  let matchedName: string | null = null;
  if (created) {
    group = { kind: 'create', name: created.name };
  } else if (groups.length > 0 && detectRelativeGroup(body)) {
    // "the latest / last / recent group" — resolve to the most recent group.
    // The list arrives most-recent-first, so position 0 is that group. The
    // phrase is lifted before matching and note-building so "latest"/"group"
    // never tip a name match or land in a description.
    group = { kind: 'existing', groupId: groups[0].id };
    matchedName = groups[0].name;
    body = stripRelativeGroupPhrase(body);
  } else {
    const groupId = matchGroup(tokenize(body), groups);
    if (groupId) {
      group = { kind: 'existing', groupId };
      matchedName = groups.find((candidate) => candidate.id === groupId)?.name ?? null;
    }
  }

  // A solo marker only routes to "Me" when the sentence named no group — an
  // explicit group beats it. When it does apply, the marker is lifted from the
  // working text so it never lands in a note or gets read as a split.
  const personal = group === null && isSelfOnlyVoiceIntent(body);
  const workBody = personal ? stripSelfOnlyPhrase(body) : body;

  const segments = segmentExpenses(workBody);
  const items: VoiceExpenseItem[] = [];
  let carriedCurrency: string | null = null;

  for (const segment of segments) {
    if (isUnsupportedVoiceExpenseClause(segment)) continue;
    const amountMajor = extractAmount(segment);
    if (amountMajor === null) continue;
    const currency: string | null = detectCurrency(segment) ?? carriedCurrency;
    if (currency) carriedCurrency = currency;
    const itemCategory = parseVoiceCategory(segment) ?? category;
    items.push({
      amountMajor,
      amountMinor: toVoiceMinorUnits(amountMajor, currency),
      currency,
      note: stripCategoryPhrase(buildNote(segment, matchedName)),
      category: itemCategory,
    });
  }

  // Nothing segmented out but there is still a single amount — treat the whole
  // sentence as one expense, matching the single-expense parser's reach.
  if (items.length === 0 && !isUnsupportedVoiceExpenseClause(workBody)) {
    const one = parseVoiceExpense(workBody, groups);
    if (one.amountMinor !== null && one.amountMajor !== null) {
      items.push({
        amountMinor: one.amountMinor,
        amountMajor: one.amountMajor,
        currency: one.currency,
        note: stripCategoryPhrase(one.note),
        category,
      });
    }
  }

  const namedCurrencies = new Set(
    items.map((item) => item.currency).filter((currency) => currency),
  );
  const finalItems =
    namedCurrencies.size === 1
      ? items.map((item) => {
          const currency = item.currency ?? [...namedCurrencies][0] ?? null;
          return currency === item.currency
            ? item
            : { ...item, currency, amountMinor: toVoiceMinorUnits(item.amountMajor, currency) };
        })
      : items;

  // Solo means nobody to split with, so no people and no split count survive to
  // the review — they would only muddy a private "Me" expense.
  const peopleText = personal ? '' : stripCategoryPhrase(workBody).trim();
  return {
    items: finalItems,
    group,
    splitCount: personal ? null : extractSplitCount(workBody),
    peopleText: peopleText || null,
    expenseDate,
    personal,
  };
}
