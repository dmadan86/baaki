/**
 * The shops people actually name, per country.
 *
 * `categories.ts` knows Swiggy, Zepto, IRCTC and kirana, which is right for the
 * market Baaki was built for and useless in Dubai — where the same expense is
 * Talabat, Careem, Lulu and Salik. Every one of those lands in "Other", and
 * "Other" is not a chart. The Spending screen does not look empty when this is
 * missing; it looks *broken*, which is worse, because a person cannot tell the
 * difference between an app that has no data and one that does not understand
 * their receipts.
 *
 * This is a layer, not a replacement. The shared list in `categories.ts` still
 * carries the ordinary English words — lunch, taxi, hotel, groceries — and a
 * market adds its own vocabulary on top. Which means a market is a few lines
 * here rather than a fork of the categoriser, and an unknown country still
 * categorises as well as it did before.
 *
 * Same rules as the shared list: lowercase, whole tokens, never substrings.
 * Brand names get their bare form (`careem`, not `careem ride`) because
 * tokenising splits the description anyway.
 */

import type { CategoryId } from './categories';

/**
 * ISO-3166 alpha-2. A market is a country because that is what payment rails,
 * currencies and shops are keyed by — not a language, which several of these
 * share.
 */
export type MarketId =
  | 'IN'
  | 'AE'
  | 'SA'
  | 'QA'
  | 'KW'
  | 'BH'
  | 'OM'
  | 'BR'
  | 'SG'
  | 'ID'
  | 'US'
  | 'CA'
  | 'AU';

type Keywords = Partial<Record<CategoryId, readonly string[]>>;

/** Shared across the Gulf: the same chains trade in all six countries. */
const GULF: Keywords = {
  food: [
    'talabat',
    'deliveroo',
    'zomato',
    'careemfood',
    'shawarma',
    'karak',
    'machboos',
    'kabsa',
    'manakish',
    'iftar',
    'suhoor',
    'brunch',
  ],
  groceries: [
    'lulu',
    'carrefour',
    'spinneys',
    'union',
    'choithrams',
    'instashop',
    'kibsons',
    'noon',
    'baqala',
    'tamimi',
    'othaim',
    'danube',
  ],
  travel: [
    'careem',
    'uber',
    'salik',
    'darb',
    'nol',
    'adnoc',
    'enoc',
    'eppco',
    'petrol',
    'metro',
    'emirates',
    'flydubai',
    'etihad',
    'rta',
    'parking',
  ],
  stay: ['hotel', 'airbnb', 'resort', 'chalet'],
  entertainment: ['vox', 'reel', 'novo', 'cinema', 'yas', 'ferrari', 'globalvillage', 'desert'],
  home: ['dewa', 'sewa', 'addc', 'etisalat', 'du', 'ejari', 'chiller', 'rent'],
  health: ['aster', 'medcare', 'nmc', 'burjeel', 'pharmacy', 'clinic'],
  shopping: ['namshi', 'sharaf', 'jumbo', 'centrepoint', 'mall'],
  gifts: ['eidiya', 'eid', 'gift'],
};

/**
 * North America and Australia share most of their chains, and the ones that
 * differ are the ones worth naming — Tim Hortons and Presto in Canada,
 * Woolworths and Opal in Australia. Delivery is the same three names
 * everywhere, which is why they sit in the shared set.
 */
const ANGLOSPHERE: Keywords = {
  food: [
    'doordash',
    'ubereats',
    'grubhub',
    'starbucks',
    'chipotle',
    'mcdonalds',
    'subway',
    'dominos',
    'takeaway',
    'takeout',
    'coffee',
  ],
  groceries: ['costco', 'walmart', 'target', 'aldi', 'groceries'],
  travel: ['uber', 'lyft', 'gas', 'petrol', 'parking', 'toll', 'flight', 'rental'],
  stay: ['airbnb', 'hotel', 'motel', 'hostel'],
  entertainment: ['netflix', 'spotify', 'cinema', 'movies', 'tickets', 'concert'],
  home: ['rent', 'electricity', 'internet', 'wifi', 'utilities'],
  health: ['pharmacy', 'dentist', 'doctor', 'gym'],
  shopping: ['amazon', 'ikea'],
};

export const MARKET_KEYWORDS: Readonly<Record<MarketId, Keywords>> = {
  // India's vocabulary already lives in the shared list, where it was the
  // starting point. Nothing to add here; the entry exists so the type is
  // complete and so it is obvious the omission is deliberate.
  IN: {},

  AE: GULF,
  SA: GULF,
  QA: GULF,
  KW: GULF,
  BH: GULF,
  OM: GULF,

  BR: {
    food: ['ifood', 'rappi', 'padaria', 'churrasco', 'lanche', 'almoco', 'jantar', 'cafe'],
    groceries: ['mercado', 'supermercado', 'carrefour', 'assai', 'atacadao', 'feira', 'hortifruti'],
    travel: ['uber', 'noventa', 'metro', 'onibus', 'gasolina', 'posto', 'pedagio', 'latam', 'gol'],
    stay: ['hotel', 'pousada', 'airbnb'],
    entertainment: ['cinema', 'ingresso', 'balada', 'show'],
    home: ['aluguel', 'condominio', 'luz', 'agua', 'internet'],
    health: ['farmacia', 'drogaria', 'medico'],
    shopping: ['shopping', 'americanas', 'magalu'],
  },

  US: {
    ...ANGLOSPHERE,
    groceries: [
      ...(ANGLOSPHERE.groceries ?? []),
      'safeway',
      'kroger',
      'publix',
      'wegmans',
      'trader',
      'instacart',
      'wholefoods',
    ],
    travel: [...(ANGLOSPHERE.travel ?? []), 'amtrak', 'metrocard', 'clipper', 'shell', 'chevron'],
    health: [...(ANGLOSPHERE.health ?? []), 'cvs', 'walgreens'],
  },

  CA: {
    ...ANGLOSPHERE,
    food: [...(ANGLOSPHERE.food ?? []), 'tims', 'timhortons', 'skipthedishes', 'poutine'],
    groceries: [
      ...(ANGLOSPHERE.groceries ?? []),
      'loblaws',
      'sobeys',
      'metro',
      'superstore',
      'nofrills',
    ],
    travel: [...(ANGLOSPHERE.travel ?? []), 'presto', 'ttc', 'via', 'petrocanada', 'esso'],
    health: [...(ANGLOSPHERE.health ?? []), 'shoppers'],
    // Canadians call the power bill hydro, and it is the one word here that
    // categorises wrongly everywhere else — which is why markets are a layer.
    home: [...(ANGLOSPHERE.home ?? []), 'hydro', 'rogers', 'telus', 'bell'],
  },

  AU: {
    ...ANGLOSPHERE,
    food: [...(ANGLOSPHERE.food ?? []), 'menulog', 'deliveroo', 'maccas', 'brekkie'],
    groceries: [...(ANGLOSPHERE.groceries ?? []), 'woolworths', 'woolies', 'coles', 'iga'],
    travel: [...(ANGLOSPHERE.travel ?? []), 'opal', 'myki', 'gocard', 'ampol', 'qantas', 'jetstar'],
    entertainment: [...(ANGLOSPHERE.entertainment ?? []), 'hoyts', 'palace'],
    home: [...(ANGLOSPHERE.home ?? []), 'telstra', 'optus', 'agl', 'origin'],
    shopping: [...(ANGLOSPHERE.shopping ?? []), 'bunnings', 'kmart', 'bigw'],
  },

  SG: {
    food: ['grabfood', 'foodpanda', 'hawker', 'kopitiam', 'zichar', 'chicken', 'laksa'],
    groceries: ['ntuc', 'fairprice', 'coldstorage', 'sheng', 'giant', 'redmart'],
    travel: ['grab', 'gojek', 'mrt', 'ez-link', 'ezlink', 'comfort', 'erp'],
    entertainment: ['golden', 'cathay', 'shaw', 'sentosa'],
    home: ['sp', 'singtel', 'starhub', 'conservancy'],
  },

  ID: {
    food: ['gofood', 'grabfood', 'warung', 'padang', 'bakso', 'nasi', 'sate', 'kopi'],
    groceries: ['indomaret', 'alfamart', 'hypermart', 'superindo', 'pasar'],
    travel: ['gojek', 'grab', 'transjakarta', 'krl', 'pertamina', 'bensin', 'tol', 'garuda'],
    stay: ['hotel', 'villa', 'homestay'],
    home: ['pln', 'listrik', 'indihome', 'kost'],
  },
};

/**
 * The extra vocabulary for a country, or nothing.
 *
 * An unrecognised country is not an error — it means the shared English list is
 * all there is, which is exactly what every market had before this file.
 */
export function keywordsForMarket(countryCode: string | null | undefined): Keywords {
  const country = (countryCode ?? '').trim().toUpperCase();
  return MARKET_KEYWORDS[country as MarketId] ?? {};
}

/** Every country this file knows something about. */
export const KNOWN_MARKETS: readonly MarketId[] = Object.keys(MARKET_KEYWORDS) as MarketId[];
