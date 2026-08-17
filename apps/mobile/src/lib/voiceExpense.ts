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
  /** What is left of the sentence once the amount, currency and group are removed. */
  note: string;
  /** The group the sentence names, or null when none or more than one fits. */
  groupId: string | null;
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
]);

/** Lowercase word tokens, punctuation and symbols stripped. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** The first number in the sentence, commas removed — "1,200.50" -> 1200.5. */
function firstNumber(text: string): number | null {
  const match = text.match(/\d[\d,]*(?:\.\d+)?/);
  if (!match) return null;
  const value = Number.parseFloat(match[0].replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
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
  const tokens = tokenize(transcript);
  const amountMajor = firstNumber(transcript);
  const amountMinor = amountMajor === null ? null : BigInt(Math.round(amountMajor * 100));
  const groupId = matchGroup(tokens, groups);
  const matchedName = groupId ? (groups.find((group) => group.id === groupId)?.name ?? null) : null;

  return {
    amountMinor,
    amountMajor,
    currency: detectCurrency(transcript),
    note: buildNote(transcript, matchedName),
    groupId,
  };
}
