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
export enum MarketId {
  IN = 'IN',
  AE = 'AE',
  SA = 'SA',
  QA = 'QA',
  KW = 'KW',
  BH = 'BH',
  OM = 'OM',
  BR = 'BR',
  SG = 'SG',
  ID = 'ID',
  US = 'US',
  CA = 'CA',
  AU = 'AU',
}

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
    'choithrams',
    'instashop',
    'kibsons',
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
  groceries: ['costco', 'walmart', 'aldi', 'groceries'],
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
  [MarketId.IN]: {},

  [MarketId.AE]: GULF,
  [MarketId.SA]: GULF,
  [MarketId.QA]: GULF,
  [MarketId.KW]: GULF,
  [MarketId.BH]: GULF,
  [MarketId.OM]: GULF,

  [MarketId.BR]: {
    food: ['ifood', 'rappi', 'padaria', 'churrasco', 'lanche', 'almoco', 'jantar', 'cafe'],
    groceries: ['mercado', 'supermercado', 'carrefour', 'assai', 'atacadao', 'feira', 'hortifruti'],
    travel: ['uber', 'noventa', 'metro', 'onibus', 'gasolina', 'posto', 'pedagio', 'latam', 'gol'],
    stay: ['hotel', 'pousada', 'airbnb'],
    entertainment: ['cinema', 'ingresso', 'balada', 'show'],
    home: ['aluguel', 'condominio', 'luz', 'agua', 'internet'],
    health: ['farmacia', 'drogaria', 'medico'],
    shopping: ['shopping', 'americanas', 'magalu'],
  },

  [MarketId.US]: {
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

  [MarketId.CA]: {
    ...ANGLOSPHERE,
    food: [...(ANGLOSPHERE.food ?? []), 'tims', 'timhortons', 'skipthedishes', 'poutine'],
    groceries: [...(ANGLOSPHERE.groceries ?? []), 'loblaws', 'sobeys', 'superstore', 'nofrills'],
    travel: [...(ANGLOSPHERE.travel ?? []), 'presto', 'ttc', 'via', 'petrocanada', 'esso'],
    health: [...(ANGLOSPHERE.health ?? []), 'shoppers'],
    // Canadians call the power bill hydro, and it is the one word here that
    // categorises wrongly everywhere else — which is why markets are a layer.
    home: [...(ANGLOSPHERE.home ?? []), 'hydro', 'rogers', 'telus', 'bell'],
  },

  [MarketId.AU]: {
    ...ANGLOSPHERE,
    food: [...(ANGLOSPHERE.food ?? []), 'menulog', 'deliveroo', 'maccas', 'brekkie'],
    groceries: [...(ANGLOSPHERE.groceries ?? []), 'woolworths', 'woolies', 'coles', 'iga'],
    travel: [...(ANGLOSPHERE.travel ?? []), 'opal', 'myki', 'gocard', 'ampol', 'qantas', 'jetstar'],
    entertainment: [...(ANGLOSPHERE.entertainment ?? []), 'hoyts', 'palace'],
    home: [...(ANGLOSPHERE.home ?? []), 'telstra', 'optus', 'agl', 'origin'],
    shopping: [...(ANGLOSPHERE.shopping ?? []), 'bunnings', 'kmart', 'bigw'],
  },

  [MarketId.SG]: {
    food: ['grabfood', 'foodpanda', 'hawker', 'kopitiam', 'zichar', 'chicken', 'laksa'],
    groceries: ['ntuc', 'fairprice', 'coldstorage', 'sheng', 'giant', 'redmart'],
    travel: ['grab', 'gojek', 'mrt', 'ezlink', 'erp'],
    entertainment: ['golden', 'cathay', 'shaw', 'sentosa'],
    home: ['singtel', 'starhub', 'conservancy'],
  },

  [MarketId.ID]: {
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

/**
 * Shared keywords a market must *not* honour, per category.
 *
 * The layer above only adds. That is right until a shared word means different
 * things in different places, and `hotel` is the one that does: a restaurant in
 * India, a place to sleep almost everywhere else. Additive keywords cannot
 * express "here it is not food", so a market states the subtractions too.
 */
export type Excludes = Partial<Record<CategoryId, readonly string[]>>;

/**
 * Outside India a hotel is where you sleep, so drop it from the shared Food
 * list and let the market's own Stay keyword win. India keeps it as food, which
 * is why there is no `IN` entry.
 */
const STAY_NOT_FOOD: Excludes = { food: ['hotel'] };

export const MARKET_EXCLUDES: Partial<Record<MarketId, Excludes>> = {
  [MarketId.AE]: STAY_NOT_FOOD,
  [MarketId.SA]: STAY_NOT_FOOD,
  [MarketId.QA]: STAY_NOT_FOOD,
  [MarketId.KW]: STAY_NOT_FOOD,
  [MarketId.BH]: STAY_NOT_FOOD,
  [MarketId.OM]: STAY_NOT_FOOD,
  [MarketId.BR]: STAY_NOT_FOOD,
  [MarketId.US]: STAY_NOT_FOOD,
  [MarketId.CA]: STAY_NOT_FOOD,
  [MarketId.AU]: STAY_NOT_FOOD,
  [MarketId.ID]: STAY_NOT_FOOD,
};

/**
 * The shared keywords a country overrides, or nothing.
 *
 * Same contract as `keywordsForMarket`: an unrecognised country subtracts
 * nothing, so the shared list stands exactly as it did before markets existed.
 */
export function excludesForMarket(countryCode: string | null | undefined): Excludes {
  const country = (countryCode ?? '').trim().toUpperCase();
  return MARKET_EXCLUDES[country as MarketId] ?? {};
}

/** Every country this file knows something about. */
export const KNOWN_MARKETS: readonly MarketId[] = Object.keys(MARKET_KEYWORDS) as MarketId[];
