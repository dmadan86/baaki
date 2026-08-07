/**
 * What an expense was for.
 *
 * The category exists for one reason: TDR §8's charts. A chart drawn over a
 * column nobody fills is an empty screen, and asking somebody to choose from a
 * menu before they can save a dinner is the sort of friction that makes people
 * stop entering expenses at all. So the category is **guessed from what they
 * already typed** and shown as a chip they can change — the same bargain as
 * ADR-008's receipts: the machine proposes, the person confirms.
 *
 * The keyword table is deliberately Indian. A general categoriser trained
 * elsewhere files an auto ride under "other" and biryani under "groceries";
 * here the ordinary vocabulary of splitting a bill in India — auto, chai,
 * Swiggy, Zepto, IRCTC, kirana — is what it knows first. Every list here is
 * lowercase and matched against whole tokens, never substrings: `ola` is a cab
 * company and also the middle of "chocolate".
 *
 * Ten categories, not fifty. A chart with fifty slices tells nobody anything,
 * and every category added is another thing to scroll past on the way to
 * saving. "Other" is a real answer and stays.
 */

export type CategoryId =
  | 'food'
  | 'groceries'
  | 'travel'
  | 'stay'
  | 'shopping'
  | 'entertainment'
  | 'home'
  | 'health'
  | 'gifts'
  | 'other';

export interface Category {
  readonly id: CategoryId;
  /** English. The app translates through its own string table (TDR §11). */
  readonly label: string;
  /** An Ionicons name. A string here keeps this package free of React. */
  readonly icon: string;
  /** Which pastel from the design system's tint family this draws in. */
  readonly tint: 'lilac' | 'pink' | 'mint' | 'peach' | 'sky' | 'coral';
  /** Lowercase whole words that mean this category. */
  readonly keywords: readonly string[];
}

export const CATEGORIES: readonly Category[] = [
  {
    id: 'food',
    label: 'Food & drink',
    icon: 'restaurant-outline',
    tint: 'peach',
    keywords: [
      'food',
      'lunch',
      'dinner',
      'breakfast',
      'brunch',
      'snacks',
      'restaurant',
      'hotel',
      'mess',
      'canteen',
      'cafe',
      'coffee',
      'chai',
      'tea',
      'juice',
      'biryani',
      'dosa',
      'idli',
      'thali',
      'pizza',
      'burger',
      'shawarma',
      'meals',
      'tiffin',
      'swiggy',
      'zomato',
      'eatsure',
      'dominos',
      'kfc',
      'mcdonalds',
      'starbucks',
      'bar',
      'beer',
      'drinks',
      'pub',
      'cake',
      'dessert',
      'icecream',
    ],
  },
  {
    id: 'groceries',
    label: 'Groceries',
    icon: 'basket-outline',
    tint: 'mint',
    keywords: [
      'groceries',
      'grocery',
      'kirana',
      'provisions',
      'sabzi',
      'vegetables',
      'fruits',
      'milk',
      'curd',
      'eggs',
      'rice',
      'atta',
      'oil',
      'bigbasket',
      'dmart',
      'blinkit',
      'zepto',
      'instamart',
      'jiomart',
      'supermarket',
      'market',
    ],
  },
  {
    id: 'travel',
    label: 'Travel',
    icon: 'car-outline',
    tint: 'sky',
    keywords: [
      'travel',
      'auto',
      'rickshaw',
      'cab',
      'taxi',
      'uber',
      'ola',
      'rapido',
      'namma',
      'yatri',
      'bus',
      'metro',
      'train',
      'irctc',
      'railway',
      'flight',
      'indigo',
      'vistara',
      'akasa',
      'airport',
      'petrol',
      'diesel',
      'fuel',
      'toll',
      'fastag',
      'parking',
      'ferry',
      'bike',
      'scooter',
      'rental',
    ],
  },
  {
    id: 'stay',
    label: 'Stay',
    icon: 'bed-outline',
    tint: 'lilac',
    keywords: [
      'stay',
      'room',
      'rooms',
      'lodge',
      'resort',
      'homestay',
      'guesthouse',
      'hostel',
      'dorm',
      'airbnb',
      'oyo',
      'treebo',
      'villa',
      'cottage',
      'checkin',
      'accommodation',
    ],
  },
  {
    id: 'shopping',
    label: 'Shopping',
    icon: 'bag-handle-outline',
    tint: 'pink',
    keywords: [
      'shopping',
      'clothes',
      'shirt',
      'saree',
      'kurta',
      'shoes',
      'chappal',
      'bag',
      'amazon',
      'flipkart',
      'myntra',
      'ajio',
      'meesho',
      'nykaa',
      'decathlon',
      'ikea',
      'mall',
    ],
  },
  {
    id: 'entertainment',
    label: 'Fun',
    icon: 'game-controller-outline',
    tint: 'coral',
    keywords: [
      'movie',
      'movies',
      'cinema',
      'pvr',
      'inox',
      'bookmyshow',
      'ticket',
      'tickets',
      'concert',
      'show',
      'netflix',
      'spotify',
      'hotstar',
      'prime',
      'game',
      'gaming',
      'bowling',
      'arcade',
      'club',
      'party',
      'trek',
      'museum',
      'zoo',
      'beach',
    ],
  },
  {
    id: 'home',
    label: 'Home & bills',
    icon: 'home-outline',
    tint: 'lilac',
    keywords: [
      'rent',
      'maintenance',
      'deposit',
      'electricity',
      'current',
      'eb',
      'water',
      'gas',
      'cylinder',
      'wifi',
      'broadband',
      'internet',
      'airtel',
      'jio',
      'bsnl',
      'dth',
      'recharge',
      'maid',
      'cook',
      'cleaning',
      'laundry',
      'repair',
      'plumber',
      'electrician',
      'furniture',
      'utensils',
    ],
  },
  {
    id: 'health',
    label: 'Health',
    icon: 'medkit-outline',
    tint: 'mint',
    keywords: [
      'medicine',
      'medicines',
      'pharmacy',
      'chemist',
      'apollo',
      'pharmeasy',
      'doctor',
      'clinic',
      'hospital',
      'scan',
      'lab',
      'test',
      'dentist',
      'gym',
      'yoga',
      'insurance',
    ],
  },
  {
    id: 'gifts',
    label: 'Gifts',
    icon: 'gift-outline',
    tint: 'pink',
    keywords: [
      'gift',
      'gifts',
      'birthday',
      'anniversary',
      'wedding',
      'flowers',
      'chocolates',
      'donation',
      'tip',
      'shagun',
    ],
  },
  {
    id: 'other',
    label: 'Other',
    icon: 'ellipsis-horizontal-circle-outline',
    tint: 'sky',
    keywords: [],
  },
];

const BY_ID = new Map<string, Category>(CATEGORIES.map((category) => [category.id, category]));

/** The fallback, and the one every unknown string resolves to. */
export const OTHER: Category = BY_ID.get('other')!;

/**
 * The category for a stored value.
 *
 * Anything unrecognised becomes "Other" rather than throwing: the column is a
 * free-text `String?` in the schema, an import can put anything in it, and a
 * chart is not worth crashing a screen over.
 */
export function categoryOf(id: string | null | undefined): Category {
  if (!id) return OTHER;
  return BY_ID.get(id.trim().toLowerCase()) ?? OTHER;
}

/** Lowercased whole words, Unicode-aware so Tamil and Hindi survive intact. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Guess from what somebody typed, or null when nothing matches.
 *
 * Null is not "other" — it means the guess has nothing to say, and the caller
 * should leave the field alone rather than assert a category the person never
 * chose. Ties go to the category listed first, which keeps the same words
 * producing the same answer on every device (the same determinism ADR-009 asks
 * of the money).
 */
export function guessCategory(description: string): CategoryId | null {
  const tokens = new Set(tokenise(description));
  if (tokens.size === 0) return null;

  let best: CategoryId | null = null;
  let bestHits = 0;
  for (const category of CATEGORIES) {
    let hits = 0;
    for (const keyword of category.keywords) {
      if (tokens.has(keyword)) hits += 1;
    }
    if (hits > bestHits) {
      best = category.id;
      bestHits = hits;
    }
  }
  return best;
}
