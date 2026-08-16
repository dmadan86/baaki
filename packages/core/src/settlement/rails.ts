/**
 * How money actually moves, per country.
 *
 * Baaki was built UPI-first, and `settle.tsx` said so: `'upi' | 'cash' |
 * 'bank'`, a union of three, one of which does not exist outside India. That is
 * fine for one market and a rewrite for every other one, so the rails are data
 * here instead — a list keyed by country, which makes Brazil a new entry rather
 * than a new screen.
 *
 * **A rail links only where somebody has published a link.**
 *
 * `upi://pay` is a published Android intent that every Indian bank app
 * implements, and it is the reason settling in Baaki takes one tap. The danger
 * with a custom scheme is that it fails *silently* when nothing is installed to
 * answer it — a tap that appears to work while no money moves — so `'app'`
 * links are checked with `canOpenURL` before they are offered.
 *
 * An https link is a different thing and is treated differently. `cash.app/
 * $tag/25` and `paypal.me/user/25USD` are public, long-standing URLs whose
 * worst case is a web page, not a lie. Those are `'web'`.
 *
 * Everything else shows the payee's handle to copy, and that is the ordinary
 * case rather than a failure: Pix is a key or a scanned EMV code, not a URL;
 * Zelle and PayID live inside each bank's own app; Venmo's app links are
 * neither documented nor stable. A rail that admits it cannot hand off is more
 * useful than one that pretends it can.
 *
 * Recording the settlement is separate from performing it either way — the
 * ledger has always tracked what people say they paid, confirmed by whoever was
 * paid (ADR-007), and that part is identical in every country.
 */

import type { CurrencyCode } from '../money/currency';

export enum RailId {
  // Instant, national, free at the point of use.
  Upi = 'upi', // India
  Pix = 'pix', // Brazil
  Paynow = 'paynow', // Singapore
  Promptpay = 'promptpay', // Thailand
  Qris = 'qris', // Indonesia
  Aani = 'aani', // United Arab Emirates
  Payid = 'payid', // Australia
  // Consumer apps.
  Zelle = 'zelle',
  Venmo = 'venmo',
  Cashapp = 'cashapp',
  Interac = 'interac',
  Wise = 'wise',
  Revolut = 'revolut',
  Paypal = 'paypal',
  // Always available, everywhere.
  Bank = 'bank',
  Cash = 'cash',
  Other = 'other',
}

/** What you need from the person being paid before anything can happen. */
export enum HandleKind {
  /** UPI ID — `name@bank`. */
  Vpa = 'vpa',
  /** A Pix key: CPF, phone, email or a random UUID. Anything goes. */
  PixKey = 'pix_key',
  /** A mobile number, usually with country code. */
  Phone = 'phone',
  Email = 'email',
  /** `$cashtag`, `@venmo-handle`. */
  Tag = 'tag',
  /** IBAN, or an account and sort code, or whatever the country uses. */
  Account = 'account',
  /** Nothing to collect — cash changed hands. */
  None = 'none',
}

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
   * How, if at all, this rail can be handed off to.
   *
   *   * `'app'` — a custom scheme like `upi://pay`, published and implemented
   *     by the banks. The risk of one of these is that it fails **silently**
   *     when nothing is installed to answer it, so the caller checks first and
   *     falls back to showing the handle.
   *   * `'web'` — a plain https URL such as `cash.app/$tag/25`. Different in
   *     kind, not degree: the worst case is a web page rather than a tap that
   *     appears to work and does not. Safe to offer without a check.
   *   * `null` — no link anybody has published. Show the handle to copy, which
   *     is the ordinary case and not a failure.
   */
  readonly link: 'app' | 'web' | null;
}

/**
 * Ordered by how directly each one moves money, so a country's best option is
 * first. `cash`, `bank` and `other` sort last in `railsFor` regardless.
 */
export const PAYMENT_RAILS: readonly PaymentRail[] = [
  {
    id: RailId.Upi,
    label: 'UPI',
    icon: 'flash-outline',
    countries: ['IN'],
    handle: HandleKind.Vpa,
    handleHint: 'Their UPI ID, like ravi@okhdfcbank',
    link: 'app',
  },
  {
    id: RailId.Pix,
    label: 'Pix',
    icon: 'flash-outline',
    countries: ['BR'],
    handle: HandleKind.PixKey,
    // A Pix key is whatever the person registered — that is the whole design of
    // it, and pretending it is one shape rejects valid keys.
    handleHint: 'Their Pix key — CPF, phone, email or random key',
    link: null,
  },
  {
    id: RailId.Paynow,
    label: 'PayNow',
    icon: 'flash-outline',
    countries: ['SG'],
    handle: HandleKind.Phone,
    handleHint: 'Their mobile number or NRIC',
    link: null,
  },
  {
    id: RailId.Promptpay,
    label: 'PromptPay',
    icon: 'flash-outline',
    countries: ['TH'],
    handle: HandleKind.Phone,
    handleHint: 'Their mobile number or national ID',
    link: null,
  },
  {
    id: RailId.Qris,
    label: 'QRIS',
    icon: 'qr-code-outline',
    countries: ['ID'],
    handle: HandleKind.Phone,
    handleHint: 'Their registered mobile number',
    link: null,
  },
  {
    id: RailId.Aani,
    label: 'Aani',
    icon: 'flash-outline',
    // The UAE's instant payment service. Transfers settle by mobile number
    // inside the bank apps; there is no public intent to hand off to.
    countries: ['AE'],
    handle: HandleKind.Phone,
    handleHint: 'Their mobile number, like +971 50 123 4567',
    link: null,
  },
  {
    id: RailId.Payid,
    label: 'PayID',
    icon: 'flash-outline',
    // Australia's instant rail over the NPP. Like Aani and PayNow, it settles
    // inside the bank apps by mobile number or email, with no public intent.
    countries: ['AU'],
    handle: HandleKind.Phone,
    handleHint: 'Their PayID — mobile number or email',
    link: null,
  },
  {
    id: RailId.Zelle,
    label: 'Zelle',
    icon: 'send-outline',
    countries: ['US'],
    handle: HandleKind.Phone,
    handleHint: 'The mobile number or email on their Zelle',
    // Zelle lives inside each bank's own app and publishes nothing to link to.
    link: null,
  },
  {
    id: RailId.Venmo,
    label: 'Venmo',
    icon: 'send-outline',
    countries: ['US'],
    handle: HandleKind.Tag,
    handleHint: 'Their Venmo handle, like @ravi-kumar',
    link: null,
  },
  {
    id: RailId.Cashapp,
    label: 'Cash App',
    icon: 'send-outline',
    countries: ['US', 'GB'],
    handle: HandleKind.Tag,
    handleHint: 'Their $cashtag',
    // `cash.app/$tag/25` is a public, long-standing URL: it opens the app when
    // it is installed and a web page when it is not, so there is no silent
    // failure to protect anybody from. Dollars only — see `buildPaymentUri`.
    link: 'web',
  },
  {
    id: RailId.Paypal,
    label: 'PayPal',
    icon: 'globe-outline',
    // PayPal.me works in every market Baaki is going to, and is the one link
    // somebody in the US, Canada or Australia can send to somebody in India.
    countries: 'any',
    handle: HandleKind.Tag,
    handleHint: 'Their PayPal.me name',
    link: 'web',
  },
  {
    id: RailId.Interac,
    label: 'Interac e-Transfer',
    icon: 'send-outline',
    countries: ['CA'],
    handle: HandleKind.Email,
    handleHint: 'The email on their Interac',
    link: null,
  },
  {
    id: RailId.Wise,
    label: 'Wise',
    icon: 'globe-outline',
    // The one that matters for a group split across countries, which is most
    // trips: everybody can receive into it.
    countries: 'any',
    handle: HandleKind.Email,
    handleHint: 'The email on their Wise account',
    link: null,
  },
  {
    id: RailId.Revolut,
    label: 'Revolut',
    icon: 'globe-outline',
    countries: 'any',
    handle: HandleKind.Tag,
    handleHint: 'Their @revtag',
    link: null,
  },
  {
    id: RailId.Bank,
    label: 'Bank transfer',
    icon: 'business-outline',
    countries: 'any',
    handle: HandleKind.Account,
    handleHint: 'Their IBAN or account number',
    link: null,
  },
  {
    id: RailId.Cash,
    label: 'Cash',
    icon: 'cash-outline',
    countries: 'any',
    handle: HandleKind.None,
    handleHint: '',
    link: null,
  },
  {
    id: RailId.Other,
    label: 'Something else',
    icon: 'ellipsis-horizontal-outline',
    countries: 'any',
    handle: HandleKind.None,
    handleHint: '',
    link: null,
  },
];

const BY_ID = new Map<RailId, PaymentRail>(PAYMENT_RAILS.map((rail) => [rail.id, rail]));

export function railById(id: string): PaymentRail | null {
  return BY_ID.get(id as RailId) ?? null;
}

/** Rails that always appear, wherever somebody is. Cash is never not an option. */
const UNIVERSAL_LAST: readonly RailId[] = [RailId.Bank, RailId.Cash, RailId.Other];

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
  return railsFor(countryCode)[0]?.id ?? RailId.Cash;
}

// ─────────────────────────────────────────────────── handles ──

const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Digits, with optional `+` and the spaces, dashes and brackets people type. */
const PHONE_RE = /^(?=(?:.*\d){6,})\+?[\d\s\-()]{6,20}$/;
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
  if (rail.handle === HandleKind.None) return true;
  if (value === '') return false;

  switch (rail.handle) {
    case HandleKind.Vpa:
      return VPA_RE.test(value);
    case HandleKind.Email:
      return EMAIL_RE.test(value);
    case HandleKind.Phone:
      return PHONE_RE.test(value);
    case HandleKind.Tag:
      return TAG_RE.test(value);
    case HandleKind.Account:
      return ACCOUNT_RE.test(value);
    case HandleKind.PixKey:
      // Deliberately permissive: a Pix key is a CPF, a phone, an email or a
      // UUID, and the person registering it chose which.
      return value.length >= 4 && value.length <= 77;
    default:
      return false;
  }
}

/**
 * Where a link leads, and how much to trust it.
 *
 * The caller needs the difference: an `'app'` URI has to be offered to
 * `canOpenURL` first, because a custom scheme with nothing installed to answer
 * it fails silently. A `'web'` one can be opened as it is.
 */
export interface PaymentLink {
  readonly kind: 'app' | 'web';
  readonly uri: string;
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
): PaymentLink | null {
  const rail = railById(input.railId);
  if (!rail?.link) return null;
  if (!isValidHandle(input.railId, input.handle)) return null;

  const handle = input.handle.trim();
  const major = formatMajor(input.amount, input.currency);
  // The web rails put the amount in the path, where only a bare decimal is
  // meaningful. A formatter may return grouping separators or a symbol, so
  // reject anything it decorated rather than open a request for the wrong sum.
  const bareMajor = /^\d+(\.\d+)?$/.test(major) ? major : null;

  if (rail.id === RailId.Upi) {
    // Built by hand rather than with URLSearchParams: this package has to
    // compile unchanged for React Native, Deno and the browser.
    const params: [string, string][] = [
      ['pa', handle],
      ['pn', input.payeeName],
      ['am', major],
      ['cu', input.currency],
    ];
    if (input.note) params.push(['tn', input.note.slice(0, 50)]);
    const query = params
      .map(([key, value]) => `${key}=${encodeURIComponent(value).replace(/%20/g, '+')}`)
      .join('&');
    return { kind: 'app', uri: `upi://pay?${query}` };
  }

  if (rail.id === RailId.Cashapp) {
    // Cash App settles in dollars. A link carrying "25" for an amount that is
    // 25 pounds would open a request for 25 of something else, which is worse
    // than no link — so anything but USD copies the handle instead.
    if (input.currency !== 'USD') return null;
    if (!bareMajor) return null;
    return {
      kind: 'web',
      uri: `https://cash.app/${encodeURIComponent(cashtag(handle))}/${bareMajor}`,
    };
  }

  if (rail.id === RailId.Paypal) {
    // PayPal.me takes the currency in the path, so unlike Cash App it is safe
    // in any of them.
    const name = handle.replace(/^@/, '');
    if (!bareMajor) return null;
    return {
      kind: 'web',
      uri: `https://paypal.me/${encodeURIComponent(name)}/${bareMajor}${input.currency}`,
    };
  }

  return null;
}

/** `$ravi` from `ravi`, `$ravi` or `@ravi` — Cash App's URLs want the dollar. */
function cashtag(handle: string): string {
  const bare = handle.replace(/^[@$]/, '');
  return `$${bare}`;
}
