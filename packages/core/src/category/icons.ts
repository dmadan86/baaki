/**
 * The *specific* icon for what an expense was for — a coffee cup for a chai, a
 * bicycle for a bike ride, a plane for a flight — one step finer than the ten
 * category icons.
 *
 * The category (categories.ts) exists for the charts: ten buckets, one icon
 * each. That is the right grain for a pie slice, and the wrong grain for a list
 * row, where "restaurant" for every meal and "car" for every ride throws away
 * the one glance-able thing a person actually wrote. So the badge on a list row
 * reads the description and, when a keyword lands, draws the exact Ionicon for
 * it; when nothing lands it falls back to the category's own icon, and the chart
 * grouping is untouched either way.
 *
 * Same discipline as `guessCategory`: lowercase whole tokens (never substrings,
 * so `car` in `carton` is not a taxi), deterministic (same words, same icon on
 * every device — ADR-009), and a real null when it has nothing to say. Every
 * icon name below is verified present in the app's Ionicons glyphmap; adding one
 * that is not renders a blank box, so keep new entries to names that exist.
 *
 * Order matters. The list is scanned top to bottom and the first entry with a
 * matching keyword wins, so the more specific reading is placed above the more
 * general one: "car rental" (car-sport) sits above a plain "cab" (car), and
 * "breakfast" (egg) above "coffee" (cafe).
 */

/** Lowercased whole words, Unicode-aware so Tamil and Hindi survive intact —
 *  the same tokenisation `guessCategory` uses, kept local so this module stays
 *  self-contained. */
function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 0),
  );
}

/**
 * Each entry is one Ionicon and the whole words that mean it. Scanned in order;
 * the first entry any description token hits is the icon. More specific readings
 * are listed above the general ones they would otherwise be swallowed by.
 */
const ICON_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  // ---- Food & drink -------------------------------------------------------
  ['egg-outline', ['breakfast', 'brunch', 'omelette', 'eggs']],
  ['nutrition-outline', ['juice', 'smoothie', 'salad', 'fruit', 'fruits']],
  ['fish-outline', ['fish', 'seafood', 'prawns', 'sushi']],
  [
    'cafe-outline',
    [
      'coffee',
      'chai',
      'tea',
      'teatime',
      'cafe',
      'latte',
      'cappuccino',
      'espresso',
      'barista',
      'starbucks',
      'ccd',
    ],
  ],
  ['pizza-outline', ['pizza', 'dominos']],
  [
    'fast-food-outline',
    [
      'burger',
      'fries',
      'snacks',
      'snack',
      'kfc',
      'mcdonalds',
      'shawarma',
      'sandwich',
      'fastfood',
      'swiggy',
      'zomato',
      'eatsure',
      'rolls',
      'momos',
    ],
  ],
  [
    'ice-cream-outline',
    ['icecream', 'dessert', 'cake', 'sweets', 'gelato', 'chocolate', 'chocolates', 'pastry'],
  ],
  ['beer-outline', ['beer', 'pub', 'brewery']],
  ['wine-outline', ['wine', 'drinks', 'cocktail', 'cocktails', 'bar']],
  [
    'restaurant-outline',
    [
      'lunch',
      'dinner',
      'meal',
      'meals',
      'thali',
      'biryani',
      'dosa',
      'idli',
      'restaurant',
      'tiffin',
      'buffet',
      'food',
    ],
  ],
  // ---- Travel -------------------------------------------------------------
  ['bicycle-outline', ['bike', 'cycle', 'bicycle', 'scooter', 'cycling', 'rapido']],
  [
    'airplane-outline',
    [
      'flight',
      'plane',
      'airfare',
      'airplane',
      'indigo',
      'vistara',
      'airindia',
      'emirates',
      'akasa',
      'airasia',
      'spicejet',
    ],
  ],
  ['train-outline', ['train', 'railway', 'irctc', 'rail']],
  ['subway-outline', ['metro', 'subway']],
  ['bus-outline', ['bus', 'redbus', 'coach']],
  ['boat-outline', ['ferry', 'boat', 'cruise', 'kayak']],
  ['speedometer-outline', ['petrol', 'diesel', 'fuel', 'fastag', 'toll']],
  ['location-outline', ['parking']],
  ['car-sport-outline', ['rental', 'carrental', 'selfdrive', 'zoomcar', 'revv']],
  [
    'car-outline',
    ['cab', 'taxi', 'uber', 'ola', 'car', 'auto', 'rickshaw', 'drive', 'airport', 'namma', 'yatri'],
  ],
  ['walk-outline', ['trek', 'trekking', 'hike', 'hiking', 'mountain', 'mountains', 'trail']],
  ['sunny-outline', ['beach', 'pool']],
  // ---- Stay ---------------------------------------------------------------
  [
    'bed-outline',
    [
      'hotel',
      'room',
      'rooms',
      'stay',
      'resort',
      'oyo',
      'lodge',
      'airbnb',
      'homestay',
      'hostel',
      'dorm',
      'guesthouse',
      'treebo',
      'villa',
      'cottage',
      'accommodation',
      'checkin',
    ],
  ],
  ['business-outline', ['apartment', 'flat', 'society']],
  // ---- Shopping / groceries ----------------------------------------------
  [
    'shirt-outline',
    [
      'clothes',
      'clothing',
      'dress',
      'shirt',
      'tshirt',
      'jeans',
      'saree',
      'kurta',
      'apparel',
      'shoes',
      'chappal',
      'laundry',
    ],
  ],
  [
    'basket-outline',
    [
      'groceries',
      'grocery',
      'vegetables',
      'sabzi',
      'kirana',
      'supermarket',
      'fruits',
      'milk',
      'curd',
      'rice',
      'atta',
      'oil',
      'provisions',
      'bigbasket',
      'blinkit',
      'zepto',
      'instamart',
      'dmart',
      'jiomart',
    ],
  ],
  ['storefront-outline', ['market', 'store']],
  ['bag-handle-outline', ['nykaa', 'ajio', 'meesho', 'decathlon', 'ikea']],
  ['cart-outline', ['amazon', 'flipkart', 'myntra', 'shopping', 'mall']],
  // ---- Entertainment ------------------------------------------------------
  ['film-outline', ['movie', 'movies', 'cinema', 'pvr', 'inox', 'netflix', 'film']],
  ['tv-outline', ['hotstar', 'prime', 'primevideo']],
  [
    'game-controller-outline',
    ['game', 'gaming', 'arcade', 'bowling', 'playstation', 'cricket', 'badminton', 'sports'],
  ],
  ['football-outline', ['football']],
  ['tennisball-outline', ['tennis']],
  ['camera-outline', ['museum', 'zoo', 'sightseeing']],
  ['musical-notes-outline', ['concert', 'music', 'spotify', 'gig', 'band']],
  ['ticket-outline', ['ticket', 'tickets', 'show', 'bookmyshow']],
  // ---- Home & bills -------------------------------------------------------
  ['home-outline', ['rent', 'deposit']],
  ['flash-outline', ['electricity', 'current', 'power']],
  ['water-outline', ['water']],
  ['flame-outline', ['gas', 'cylinder', 'lpg']],
  ['wifi-outline', ['wifi', 'internet', 'broadband']],
  ['tv-outline', ['dth', 'cable']],
  ['people-outline', ['maid', 'cook']],
  ['hammer-outline', ['furniture', 'utensils']],
  ['trash-outline', ['garbage', 'trash']],
  [
    'phone-portrait-outline',
    ['recharge', 'mobile', 'airtel', 'jio', 'bsnl', 'postpaid', 'prepaid'],
  ],
  ['construct-outline', ['repair', 'plumber', 'electrician', 'maintenance']],
  // ---- Health -------------------------------------------------------------
  ['medical-outline', ['doctor', 'clinic', 'hospital', 'dentist', 'apollo', 'pharmeasy']],
  ['fitness-outline', ['yoga']],
  ['barbell-outline', ['gym', 'workout', 'fitness']],
  ['flask-outline', ['lab', 'scan', 'test']],
  ['heart-outline', ['insurance', 'therapy']],
  ['medkit-outline', ['medicine', 'medicines', 'pharmacy', 'chemist']],
  // ---- Gifts --------------------------------------------------------------
  ['flower-outline', ['flowers', 'bouquet']],
  ['heart-outline', ['donation', 'charity']],
  ['cash-outline', ['tip']],
  ['gift-outline', ['gift', 'gifts', 'present', 'birthday', 'anniversary', 'wedding', 'shagun']],
];

/**
 * The specific Ionicon for a description, or null when no keyword lands.
 *
 * Null is not a blank icon — it means "no opinion", and the caller falls back to
 * the category's icon. Keyword matching is whole-token and case-insensitive; the
 * first entry (top to bottom) any token hits wins, which keeps the answer stable
 * and lets the specific readings sit above the general ones.
 */
export function guessIcon(description: string | null | undefined): string | null {
  if (!description) return null;
  const tokens = tokenise(description);
  if (tokens.size === 0) return null;
  for (const [icon, keywords] of ICON_KEYWORDS) {
    for (const keyword of keywords) {
      if (tokens.has(keyword)) return icon;
    }
  }
  return null;
}
