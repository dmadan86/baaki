/**
 * How money actually moves, per country.
 *
 * Baaki was built UPI-first, and `settle.tsx` said so: `'upi' | 'cash' |
 * 'bank'`, a union of three, one of which does not exist outside India. That is
 * fine for one market and a rewrite for every other one, so the rails are data
 * here instead — a list keyed by country, which makes Brazil a new entry rather
 * than a new screen.
 *
 * **Only UPI has a deep link, and that is deliberate.**
 *
 * `upi://pay` is a published Android intent that every Indian bank app
 * implements, and it is the reason settling in Baaki takes one tap. Almost
 * nothing else works that way. Pix is a copy-and-paste key or a scanned EMV
 * code, not a URL. Zelle and Venmo have app links that are neither documented
 * nor stable, and guessing at one produces a button that silently fails on
 * somebody's phone while they believe they have paid. So a rail either has a
 * scheme we can stand behind, or it shows the payee's handle to copy and the
 * person finishes in their own bank app. A rail that admits it cannot hand off
 * is more useful than one that pretends it can.
 *
 * Recording the settlement is separate from performing it either way — the
 * ledger has always tracked what people say they paid, confirmed by whoever was
 * paid (ADR-007), and that part is identical in every country.
 */

import type { CurrencyCode } from '../money/currency';

export type RailId =
  // Instant, national, free at the point of use.
  | 'upi' // India
  | 'pix' // Brazil
  | 'paynow' // Singapore
  | 'promptpay' // Thailand
  | 'qris' // Indonesia
  | 'aani' // United Arab Emirates
  // Consumer apps.
  | 'zelle'
  | 'venmo'
  | 'cashapp'
  | 'interac'
  | 'wise'
  | 'revolut'
  // Always available, everywhere.
  | 'bank'
  | 'cash'
  | 'other';

/** What you need from the person being paid before anything can happen. */
export type HandleKind =
  /** UPI ID — `name@bank`. */
  | 'vpa'
  /** A Pix key: CPF, phone, email or a random UUID. Anything goes. */
  | 'pix_key'
  /** A mobile number, usually with country code. */
  | 'phone'
  | 'email'
  /** `$cashtag`, `@venmo-handle`. */
  | 'tag'
  /** IBAN, or an account and sort code, or whatever the country uses. */
  | 'account'
  /** Nothing to collect — cash changed hands. */
  | 'none';

export interface PaymentRail {
  readonly id: RailId;
  /** English. The app translates through its own string table (TDR §11). */
  readonly label: string;
  /** An Ionicons name, as with categories — keeps this package free of React. */
  readonly icon: string;
  /**
   * ISO-3166 alpha-2 codes this rail serves, or `'any'` for the ones that work
   * wherever there is a bank or a wallet.
   */
  readonly countries: readonly string[] | 'any';
  readonly handle: HandleKind;
  /** Shown under the field, in the local vocabulary. */
  readonly handleHint: string;
  /**
   * True only where a deep link is published, implemented by the banks, and
   * has been seen to work. Everything else is copy-the-handle.
   */
  readonly deepLink: boolean;
}

/**
 * Ordered by how directly each one moves money, so a country's best option is
 * first. `cash`, `bank` and `other` sort last in `railsFor` regardless.
 */
export const PAYMENT_RAILS: readonly PaymentRail[] = [
  {
    id: 'upi',
    label: 'UPI',
    icon: 'flash-outline',
    countries: ['IN'],
    handle: 'vpa',
    handleHint: 'Their UPI ID, like ravi@okhdfcbank',
    deepLink: true,
  },
  {
    id: 'pix',
    label: 'Pix',
    icon: 'flash-outline',
    countries: ['BR'],
    handle: 'pix_key',
    // A Pix key is whatever the person registered — that is the whole design of
    // it, and pretending it is one shape rejects valid keys.
    handleHint: 'Their Pix key — CPF, phone, email or random key',
    deepLink: false,
  },
  {
    id: 'paynow',
    label: 'PayNow',
    icon: 'flash-outline',
    countries: ['SG'],
    handle: 'phone',
    handleHint: 'Their mobile number or NRIC',
    deepLink: false,
  },
  {
    id: 'promptpay',
    label: 'PromptPay',
    icon: 'flash-outline',
    countries: ['TH'],
    handle: 'phone',
    handleHint: 'Their mobile number or national ID',
    deepLink: false,
  },
  {
    id: 'qris',
    label: 'QRIS',
    icon: 'qr-code-outline',
    countries: ['ID'],
    handle: 'phone',
    handleHint: 'Their registered mobile number',
    deepLink: false,
  },
  {
    id: 'aani',
    label: 'Aani',
    icon: 'flash-outline',
    // The UAE's instant payment service. Transfers settle by mobile number
    // inside the bank apps; there is no public intent to hand off to.
    countries: ['AE'],
    handle: 'phone',
    handleHint: 'Their mobile number, like +971 50 123 4567',
    deepLink: false,
  },
  {
    id: 'zelle',
    label: 'Zelle',
    icon: 'send-outline',
    countries: ['US'],
    handle: 'phone',
    handleHint: 'The mobile number or email on their Zelle',
    deepLink: false,
  },
  {
    id: 'venmo',
    label: 'Venmo',
    icon: 'send-outline',
    countries: ['US'],
    handle: 'tag',
    handleHint: 'Their Venmo handle, like @ravi-kumar',
    deepLink: false,
  },
  {
    id: 'cashapp',
    label: 'Cash App',
    icon: 'send-outline',
    countries: ['US', 'GB'],
    handle: 'tag',
    handleHint: 'Their $cashtag',
    deepLink: false,
  },
  {
    id: 'interac',
    label: 'Interac e-Transfer',
    icon: 'send-outline',
    countries: ['CA'],
    handle: 'email',
    handleHint: 'The email on their Interac',
    deepLink: false,
  },
  {
    id: 'wise',
    label: 'Wise',
    icon: 'globe-outline',
    // The one that matters for a group split across countries, which is most
    // trips: everybody can receive into it.
    countries: 'any',
    handle: 'email',
    handleHint: 'The email on their Wise account',
    deepLink: false,
  },
  {
    id: 'revolut',
    label: 'Revolut',
    icon: 'globe-outline',
    countries: 'any',
    handle: 'tag',
    handleHint: 'Their @revtag',
    deepLink: false,
  },
  {
    id: 'bank',
    label: 'Bank transfer',
    icon: 'business-outline',
    countries: 'any',
    handle: 'account',
    handleHint: 'Their IBAN or account number',
    deepLink: false,
  },
  {
    id: 'cash',
    label: 'Cash',
    icon: 'cash-outline',
    countries: 'any',
    handle: 'none',
    handleHint: '',
    deepLink: false,
  },
  {
    id: 'other',
    label: 'Something else',
    icon: 'ellipsis-horizontal-outline',
    countries: 'any',
    handle: 'none',
    handleHint: '',
    deepLink: false,
  },
];

const BY_ID = new Map<RailId, PaymentRail>(PAYMENT_RAILS.map((rail) => [rail.id, rail]));

export function railById(id: string): PaymentRail | null {
  return BY_ID.get(id as RailId) ?? null;
}

/** Rails that always appear, wherever somebody is. Cash is never not an option. */
const UNIVERSAL_LAST: readonly RailId[] = ['bank', 'cash', 'other'];

/**
 * What this country can pay with, best first.
 *
 * An unknown or missing country still gets a usable list rather than an empty
 * one — somebody who never set a country can still record that they paid in
 * cash, and a group settling in a country nobody configured is not a group that
 * should be told it cannot settle.
 */
export function railsFor(countryCode: string | null | undefined): readonly PaymentRail[] {
  const country = (countryCode ?? '').trim().toUpperCase();

  const national = PAYMENT_RAILS.filter(
    (rail) =>
      rail.countries !== 'any' &&
      country !== '' &&
      rail.countries.includes(country) &&
      !UNIVERSAL_LAST.includes(rail.id),
  );

  const global = PAYMENT_RAILS.filter(
    (rail) => rail.countries === 'any' && !UNIVERSAL_LAST.includes(rail.id),
  );

  const last = UNIVERSAL_LAST.map((id) => BY_ID.get(id)).filter(
    (rail): rail is PaymentRail => rail !== undefined,
  );

  return [...national, ...global, ...last];
}

/** The rail a country leads with — what the settle screen selects by default. */
export function defaultRailFor(countryCode: string | null | undefined): RailId {
  return railsFor(countryCode)[0]?.id ?? 'cash';
}

// ─────────────────────────────────────────────────── handles ──

const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Digits, with optional `+` and the spaces, dashes and brackets people type. */
const PHONE_RE = /^\+?[\d\s\-()]{6,20}$/;
const TAG_RE = /^[@$]?[a-zA-Z0-9._-]{2,64}$/;
const ACCOUNT_RE = /^[a-zA-Z0-9\s-]{4,40}$/;

/**
 * Whether this is plausibly the handle the rail asked for.
 *
 * Plausibly, not certainly. The only thing that truly validates a payment
 * handle is a payment, and a validator strict enough to be sure would reject
 * somebody's real account and leave them unable to record a debt they owe.
 * Wrong here means one confused tap; wrong the other way means the app is
 * broken for them.
 */
export function isValidHandle(railId: string, handle: string): boolean {
  const rail = railById(railId);
  if (!rail) return false;

  const value = handle.trim();
  if (rail.handle === 'none') return true;
  if (value === '') return false;

  switch (rail.handle) {
    case 'vpa':
      return VPA_RE.test(value);
    case 'email':
      return EMAIL_RE.test(value);
    case 'phone':
      return PHONE_RE.test(value);
    case 'tag':
      return TAG_RE.test(value);
    case 'account':
      return ACCOUNT_RE.test(value);
    case 'pix_key':
      // Deliberately permissive: a Pix key is a CPF, a phone, an email or a
      // UUID, and the person registering it chose which.
      return value.length >= 4 && value.length <= 77;
    default:
      return false;
  }
}

export interface PaymentLinkInput {
  readonly railId: string;
  readonly handle: string;
  readonly payeeName: string;
  /** Minor units. */
  readonly amount: bigint;
  readonly currency: CurrencyCode;
  readonly note?: string;
}

/**
 * A URI that hands off to a payment app, or `null` when this rail has none.
 *
 * `null` is the ordinary answer, not a failure — the caller shows the handle to
 * copy instead. See the note at the top about why we do not guess at schemes.
 */
export function buildPaymentUri(
  input: PaymentLinkInput,
  formatMajor: (amount: bigint, currency: CurrencyCode) => string,
): string | null {
  const rail = railById(input.railId);
  if (!rail?.deepLink) return null;
  if (!isValidHandle(input.railId, input.handle)) return null;

  if (rail.id === 'upi') {
    // Built by hand rather than with URLSearchParams: this package has to
    // compile unchanged for React Native, Deno and the browser.
    const params: [string, string][] = [
      ['pa', input.handle.trim()],
      ['pn', input.payeeName],
      ['am', formatMajor(input.amount, input.currency)],
      ['cu', input.currency],
    ];
    if (input.note) params.push(['tn', input.note.slice(0, 50)]);
    const query = params
      .map(([key, value]) => `${key}=${encodeURIComponent(value).replace(/%20/g, '+')}`)
      .join('&');
    return `upi://pay?${query}`;
  }

  return null;
}
