/**
 * Turning a stored notification into a sentence somebody can read.
 *
 * The row in `notifications` holds a `kind` and a `payload`, plus an English
 * `title`/`body` that exist only so a row is never blank. The real wording is
 * built here, from the copy table, in the reader's language — because Postgres
 * wrote that row and Postgres has no business holding three translations of
 * every sentence, nor any idea which of them this particular person reads
 * (TDR §11: en + ta + hi from day one, and ar since the layout learned to
 * mirror).
 *
 * Amounts are formatted from minor units at the same moment, for the same
 * reason: `42000` is not `₹420.00` until you know both the currency and the
 * locale, and neither was known when the row was written.
 */

import { format, money, type CurrencyCode } from '../money/index';
import { copyFor, interpolate, type NotificationKind } from './copy';

/**
 * The facts a notification row carries. Everything is optional because a kind
 * only uses the ones it names — a missing fact leaves its placeholder visible
 * rather than printing "undefined" at somebody.
 */
export interface NotificationFacts {
  /** Minor units as a decimal string; bigint, so never a JSON number. */
  readonly amount?: string;
  readonly currency?: string;
  readonly counterparty?: string;
  readonly group?: string;
  readonly description?: string;
  readonly count?: string;
  /** The ghost member being claimed — used by the ghost-claim kinds. */
  readonly name?: string;
}

export interface RenderedNotification {
  readonly title: string;
  readonly body: string;
}

/**
 * @param fallback the English title/body stored on the row, used when the kind
 * is one this build of the app has never heard of — an older client reading a
 * newer server's notification still shows something true.
 */
export function renderNotification(
  kind: string,
  facts: NotificationFacts,
  locale: string,
  fallback?: RenderedNotification,
): RenderedNotification {
  const copy = copyFor(locale);
  const template = copy.notifications[kind as NotificationKind];
  if (!template) return fallback ?? { title: kind, body: '' };

  const values: Record<string, string> = {};
  if (facts.counterparty) values.actor = facts.counterparty;
  if (facts.group) values.group = facts.group;
  if (facts.description) values.description = facts.description;
  if (facts.count) values.count = facts.count;
  if (facts.name) values.name = facts.name;

  const amount = formatAmount(facts, locale);
  if (amount) values.amount = amount;

  return {
    title: interpolate(template.title, values),
    body: interpolate(template.body, values),
  };
}

function formatAmount(facts: NotificationFacts, locale: string): string | null {
  if (!facts.amount || !facts.currency) return null;
  try {
    return format(money(BigInt(facts.amount), facts.currency as CurrencyCode), { locale });
  } catch {
    // A currency this build does not know, or an amount that is not a whole
    // number of minor units. Showing the rest of the sentence beats showing
    // nothing.
    return null;
  }
}
