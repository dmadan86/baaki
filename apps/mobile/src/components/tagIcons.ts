/**
 * The glyphs a custom expense tag may wear (extends TDR §8).
 *
 * A wide, curated set of Ionicons — the everyday shapes of spending across food,
 * travel, home, work, health, fun, people and money — not the whole glyph map,
 * which would be a wall of arrows and logos nobody tags a bill with. All outline
 * style, to sit beside the built-in categories, grouped so the picker reads in
 * bands rather than as one undifferentiated grid. Its own module so a test can
 * assert every name is a real glyph.
 */

import Ionicons from '@expo/vector-icons/Ionicons';

export type IoniconName = keyof typeof Ionicons.glyphMap;

/** Grouped for the picker; flattened into `TAG_ICONS` below. */
export const TAG_ICON_GROUPS: readonly (readonly IoniconName[])[] = [
  // Food & drink
  [
    'restaurant-outline',
    'fast-food-outline',
    'pizza-outline',
    'cafe-outline',
    'beer-outline',
    'wine-outline',
    'nutrition-outline',
    'ice-cream-outline',
    'egg-outline',
    'fish-outline',
  ],
  // Groceries & shopping
  [
    'cart-outline',
    'basket-outline',
    'bag-handle-outline',
    'pricetag-outline',
    'pricetags-outline',
    'shirt-outline',
    'gift-outline',
    'storefront-outline',
    'cube-outline',
    'balloon-outline',
  ],
  // Getting around
  [
    'car-outline',
    'car-sport-outline',
    'bus-outline',
    'train-outline',
    'subway-outline',
    'bicycle-outline',
    'boat-outline',
    'airplane-outline',
    'rocket-outline',
    'walk-outline',
  ],
  // Travel & stay
  [
    'bed-outline',
    'business-outline',
    'map-outline',
    'compass-outline',
    'earth-outline',
    'sunny-outline',
    'umbrella-outline',
    'camera-outline',
    'ticket-outline',
    'trail-sign-outline',
  ],
  // Home, bills & utilities
  [
    'home-outline',
    'bulb-outline',
    'flash-outline',
    'water-outline',
    'flame-outline',
    'wifi-outline',
    'call-outline',
    'tv-outline',
    'construct-outline',
    'hammer-outline',
    'trash-outline',
    'shield-checkmark-outline',
  ],
  // Work & study
  [
    'briefcase-outline',
    'laptop-outline',
    'desktop-outline',
    'print-outline',
    'document-text-outline',
    'school-outline',
    'book-outline',
    'library-outline',
    'calculator-outline',
    'mail-outline',
  ],
  // Health & fitness
  [
    'medkit-outline',
    'medical-outline',
    'fitness-outline',
    'barbell-outline',
    'heart-outline',
    'pulse-outline',
    'bandage-outline',
    'eye-outline',
    'flask-outline',
    'leaf-outline',
  ],
  // Fun & hobbies
  [
    'game-controller-outline',
    'musical-notes-outline',
    'headset-outline',
    'film-outline',
    'football-outline',
    'basketball-outline',
    'tennisball-outline',
    'golf-outline',
    'color-palette-outline',
    'brush-outline',
    'dice-outline',
    'planet-outline',
  ],
  // People, gifts & celebration
  [
    'people-outline',
    'person-outline',
    'happy-outline',
    'sparkles-outline',
    'ribbon-outline',
    'trophy-outline',
    'star-outline',
    'flower-outline',
    'paw-outline',
    'accessibility-outline',
  ],
  // Money & the rest
  [
    'card-outline',
    'cash-outline',
    'wallet-outline',
    'pie-chart-outline',
    'trending-up-outline',
    'receipt-outline',
    'time-outline',
    'calendar-outline',
    'key-outline',
    'ellipsis-horizontal-circle-outline',
  ],
];

/** The flat list the editor renders — every group, in order. */
export const TAG_ICONS: readonly IoniconName[] = TAG_ICON_GROUPS.flat();

/** The default a new tag starts on. */
export const DEFAULT_TAG_ICON: IoniconName = 'pricetag-outline';
