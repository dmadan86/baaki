/**
 * i18n from day one (TDR §11): en, ta, hi and now ar, with locale-aware money
 * and date formatting everywhere. Notification copy lives in
 * @baaki/core/notifications so the server sends the same words.
 *
 * The phone's own language is the default and always will be. What sits on top
 * of it now is a choice — `LanguageProvider` in `./language` — because the
 * phone is one setting for one person and this app is used by people who read
 * one language and set their phone to another. Somebody in Chennai with an
 * English phone reads Tamil faster than they read English.
 *
 * Arabic is the first right-to-left language here, and it is more than a fourth
 * column of strings — the whole layout mirrors. React Native does that itself
 * when `I18nManager.isRTL` is true, and it decides that once, natively, at
 * launch. `extra.supportsRTL` in app.json is what lets the native side honour
 * it; `./language` is where the restart that a direction change needs is
 * explained rather than hidden.
 *
 * React Native mirrors more than it gets credit for: with
 * `doLeftAndRightSwapInRTL` — true by default — it swaps `left`/`right` in
 * styles, reverses `flexDirection: 'row'` and flips `textAlign`. So the
 * `marginLeft`s and `paddingRight`s scattered through this app are not bugs in
 * an RTL layout, and rewriting them to `marginStart`/`paddingEnd` would change
 * nothing at all.
 *
 * What it cannot mirror is an **icon**, because an icon is content rather than
 * layout. `chevron-forward` keeps pointing right in a screen that now runs the
 * other way, so "next" points backwards. `directionalIcon` in @baaki/ui is the
 * fix, and every arrow in the app goes through it.
 */

import { createContext, useContext } from 'react';
import { getLocales } from 'expo-localization';

import type { CategoryId } from '@baaki/core';

export type Language = 'en' | 'ta' | 'hi' | 'ar';

/** Every language this app speaks, in the order the picker lists them. */
export const LANGUAGES: readonly Language[] = ['en', 'ta', 'hi', 'ar'];

/** The languages that read right to left. */
export const RTL_LANGUAGES: readonly Language[] = ['ar'];

/**
 * What each language calls itself, and what English calls it.
 *
 * The endonym leads. Somebody looking for their own language is scanning for
 * the shape of their own script, and "Tamil" written in Latin letters is not
 * that shape — it is the name of their language in a language they may not
 * read. The English gloss follows for everyone else.
 */
export const LANGUAGE_NAMES: Readonly<Record<Language, { own: string; english: string }>> = {
  en: { own: 'English', english: 'English' },
  ta: { own: 'தமிழ்', english: 'Tamil' },
  hi: { own: 'हिन्दी', english: 'Hindi' },
  ar: { own: 'العربية', english: 'Arabic' },
};

export function isRtlLanguage(language: Language): boolean {
  return RTL_LANGUAGES.includes(language);
}

/**
 * The forms a phrase takes as its number changes.
 *
 * English has two and the app was written as though every language does:
 * `${n} expense${n === 1 ? '' : 's'}` appeared in nine files. That is not a
 * shortcut, it is a claim — that "one" and "not one" is the whole of it — and
 * it is false in three of the four languages here. Arabic has six categories
 * and treats 2, 11 and 100 differently; Tamil and Hindi do not build plurals by
 * suffix at all, so the English trick produces a word that does not exist.
 *
 * `other` is the only required form because it is the only one every language
 * uses. `Intl.PluralRules` decides which of the rest apply, so a table that
 * fills in `one` and `other` is correct English and correct Tamil, and a table
 * that fills in all six is correct Arabic.
 */
export interface PluralForms {
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

/**
 * Picks the form and puts the number in it.
 *
 * `{n}` is replaced with the count formatted for the locale, not with
 * `String(count)` — an Egyptian Arabic locale writes ١٢ and a phrase that says
 * "12" beside Arabic words is a phrase in two number systems.
 */
export function plural(locale: string, count: number, forms: PluralForms): string {
  let rule: Intl.LDMLPluralRule = 'other';
  let shown = String(count);
  try {
    rule = new Intl.PluralRules(locale).select(count);
    shown = new Intl.NumberFormat(locale).format(count);
  } catch {
    // A locale Intl will not take is not a reason to render nothing. The
    // English-shaped `other` form with a plain number beats an empty row.
  }
  return (forms[rule] ?? forms.other).replaceAll('{n}', shown);
}

export interface UiStrings {
  greeting: string;
  yourBaaki: string;
  acrossGroups: string;
  youAreOwed: string;
  youOwe: string;
  allSettled: string;
  yourGroups: string;
  newGroup: string;
  activity: string;
  friends: string;
  profile: string;
  home: string;
  addExpense: string;
  scanBill: string;
  settleUp: string;
  simplify: string;
  whoPaysWhom: string;
  expenses: string;
  balances: string;
  paidBy: string;
  splitEqually: string;
  description: string;
  save: string;
  pendingConfirmation: string;
  toConfirm: string;
  overallOwed: string;
  overallOwe: string;
  payViaUpi: string;
  paidInCash: string;
  bankOther: string;
  perExpense: string;
  members: string;
  notJoinedYet: string;
  scansLeft: string;
  simplifyOn: string;
  simplifyOff: string;
  freeForever: string;
  nothingYet: string;
  nothingYetBody: string;
  whatFor: string;
  spending: string;
  byCategory: string;
  byMonth: string;
  nothingToChart: string;
  /** The ten categories of TDR §8, in the language the phone is set to. */
  categories: Record<CategoryId, string>;
  /**
   * The three cards before sign-in. They were literals in `Onboarding.tsx`
   * until Arabic arrived — which meant the very first screen of an app being
   * launched in the Gulf was in English, and told the reader about rupees and
   * UPI apps. The first screen is the worst place to be somewhere else.
   */
  onboarding: readonly { title: string; body: string }[];
  plan: string;
  planned: string;
  spent: string;
  overBudget: string;
  underBudget: string;
  nothingPlannedYet: string;
  planEmptyBody: string;
  whatIsPlanned: string;
  add: string;
  cancel: string;
  whichGroup: string;
  skip: string;
  next: string;
  getStarted: string;
  /**
   * The two words on the account screen that have to be in the reader's own
   * language even when the app is in the wrong one — because "Language" is what
   * somebody who has opened the app in a language they cannot read is hunting
   * for, and a row labelled in that same unreadable language is no help at all.
   */
  language: string;
  upgrade: string;
  /**
   * The words that are on almost every screen.
   *
   * "Back" appeared as an English literal in nineteen files, "Close" in seven.
   * Translating each one where it stood would have meant nineteen chances to
   * write a different word for the same button, so they live here once. Nothing
   * belongs in this group unless it is genuinely the same word everywhere —
   * a label that means something slightly different on two screens is two
   * labels, and sharing it is how translations go subtly wrong.
   */
  common: {
    back: string;
    close: string;
    cancel: string;
    save: string;
    edit: string;
    remove: string;
    delete: string;
    share: string;
    done: string;
    guest: string;
    name: string;
    yourName: string;
    emailOrPhone: string;
    notFound: string;
    goBack: string;
  };
  /** Getting the whole ledger out, in full and for free (ADR-012). */
  exportData: {
    title: string;
    everythingFree: string;
    noPaywall: string;
    explain: string;
    format: string;
    json: string;
    csv: string;
    whatToExport: string;
    allMyGroups: string;
    preparing: string;
    action: string;
    ready: string;
    webNote: string;
    shareTitle: string;
    importInstead: string;
  };
  /** The motion switch, and the phone setting it defers to. */
  motion: {
    title: string;
    animateBetweenScreens: string;
    animateExplain: string;
    thisPhone: string;
    reduceMotionOn: string;
    reduceMotionOff: string;
    setYourselfOn: string;
    setYourselfOff: string;
    followingReduced: string;
    following: string;
    followPhone: string;
    footnote: string;
  };
  /** The app lock, the delay before it asks again, and the way out. */
  lock: {
    title: string;
    requireBiometrics: string;
    requireExplain: string;
    appLock: string;
    unsupported: string;
    askAgainAfter: string;
    askAgainExplain: string;
    graceImmediate: string;
    graceSeconds: PluralForms;
    graceMinutes: PluralForms;
    reopenAlwaysAsks: string;
    signOut: string;
    signOutGuest: string;
    signOutMember: string;
    signOutQuestion: string;
    signOutGuestWarning: string;
    signOutReassure: string;
    staySignedIn: string;
    footnote: string;
  };
  /** The account screen and its three faces. */
  account: {
    faceYou: string;
    facePaying: string;
    faceSettings: string;
    settled: string;
    nothingSettledYet: string;
    otherCurrencies: PluralForms;
    saved: string;
    displayName: string;
    you: string;
    guestAccount: string;
    guestAccountBody: string;
    addYourDetails: string;
    yourPhoto: string;
    chooseNewPhoto: string;
    howPeoplePayYou: string;
    yourRailDetails: string;
    handleWrong: string;
    railLinkNote: string;
    railManualNote: string;
    nothingToAdd: string;
    sectionBaaki: string;
    sectionSettings: string;
    sectionSecurity: string;
    upgradeHint: string;
    yourAccount: string;
    yourAccountHint: string;
    notifications: string;
    notificationsHint: string;
    exportDataRow: string;
    exportHint: string;
    importSplitwise: string;
    importHint: string;
    motionRow: string;
    languageFollowingPhone: string;
    languageRestartHint: string;
    lockNoBiometrics: string;
    lockOn: string;
    lockOff: string;
    signOutGuestHint: string;
    signOutHint: string;
    motionOn: string;
    motionOff: string;
    motionFollowingOn: string;
    motionFollowingOff: string;
    footnote: string;
  };
}

const en: UiStrings = {
  greeting: 'Hello',
  yourBaaki: 'Your baaki',
  acrossGroups: 'across {count} groups',
  youAreOwed: 'You are owed',
  youOwe: 'You owe',
  allSettled: 'All settled',
  yourGroups: 'Your groups',
  newGroup: 'New group',
  activity: 'Activity',
  friends: 'Friends',
  profile: 'Account',
  home: 'Home',
  addExpense: 'Add expense',
  scanBill: 'Scan bill',
  settleUp: 'Settle up',
  simplify: 'Simplify',
  whoPaysWhom: 'Who pays whom',
  expenses: 'Expenses',
  balances: 'Balances',
  paidBy: 'Paid by',
  splitEqually: 'Split equally',
  description: 'What was it for?',
  save: 'Save expense',
  pendingConfirmation: 'pending confirmation',
  toConfirm: 'To confirm',
  overallOwed: 'you are owed overall',
  overallOwe: 'your baaki to pay',
  payViaUpi: 'Pay via UPI',
  paidInCash: 'Paid in cash',
  bankOther: 'Bank / other',
  perExpense: 'Apply to specific expenses',
  members: 'Members',
  notJoinedYet: 'not joined yet',
  scansLeft: 'scans left',
  simplifyOn: 'Simplify on',
  simplifyOff: 'Simplify off',
  freeForever: 'Unlimited and free, forever',
  nothingYet: 'Nothing here yet',
  nothingYetBody: 'Add your first expense and the maths takes care of itself.',
  whatFor: 'What kind of expense',
  spending: 'Spending',
  byCategory: 'Where it went',
  byMonth: 'Month by month',
  nothingToChart: 'Add a few expenses and this fills in.',
  categories: {
    food: 'Food & drink',
    groceries: 'Groceries',
    travel: 'Travel',
    stay: 'Stay',
    shopping: 'Shopping',
    entertainment: 'Fun',
    home: 'Home & bills',
    health: 'Health',
    gifts: 'Gifts',
    other: 'Other',
  },
  plan: 'Plan',
  planned: 'Planned',
  spent: 'Spent',
  overBudget: 'over',
  underBudget: 'under',
  nothingPlannedYet: 'Nothing planned yet',
  planEmptyBody: 'Add the days and what you mean to do. What it actually costs fills itself in.',
  whatIsPlanned: 'What are you doing?',
  add: 'Add',
  cancel: 'Cancel',
  whichGroup: 'Which group is this for?',
  skip: 'Skip',
  next: 'Next',
  getStarted: 'Get started',
  language: 'Language',
  upgrade: 'Upgrade',
  common: {
    back: 'Back',
    close: 'Close',
    cancel: 'Cancel',
    save: 'Save',
    edit: 'Edit',
    remove: 'Remove',
    delete: 'Delete',
    share: 'Share',
    done: 'Done',
    guest: 'Guest',
    name: 'Name',
    yourName: 'Your name',
    emailOrPhone: 'Email or phone number',
    notFound: 'Not found',
    goBack: 'Go back',
  },
  onboarding: [
    {
      // Not "split anything with anyone" — that is the welcome's line, and the
      // welcome is the very next screen.
      title: 'Dinner, rent,\na whole trip',
      body: 'Baaki keeps who paid and who owes, down to the last decimal — free, and with no account to make first.',
    },
    {
      title: 'Send a link,\nthey are in',
      body: 'The people you split with do not need to install anything. They open a link and see the same numbers you do.',
    },
    {
      // "your payment app", not "your UPI app": this is the first screen
      // somebody in Dubai or São Paulo sees, and UPI means nothing there.
      title: 'Settle it\nin one tap',
      body: 'Baaki hands the exact amount to your payment app, so nobody does the arithmetic twice and nobody is owed a rounding error.',
    },
  ],
  exportData: {
    title: 'Export your data',
    everythingFree: 'Everything, always free',
    noPaywall: 'no paywall',
    explain:
      'JSON includes every version of every expense, who paid, who owed, settlements with their per-expense allocations, and the activity trail — enough to rebuild your ledger exactly. CSV is the spreadsheet view, including per-person settlement detail.',
    format: 'Format',
    json: 'JSON (lossless)',
    csv: 'CSV (spreadsheet)',
    whatToExport: 'What to export',
    allMyGroups: 'All my groups',
    preparing: 'Preparing…',
    action: 'Export',
    ready: 'Export ready',
    webNote: 'On web the file is written to the app cache; use a device to share it onward.',
    shareTitle: 'Your Baaki export',
    importInstead: 'Import from Splitwise',
  },
  motion: {
    title: 'Motion',
    animateBetweenScreens: 'Animate between screens',
    animateExplain:
      'Screens slide in from the right, and sheets rise from the bottom — which is how a screen tells you whether you have gone somewhere or opened something on top of where you were.',
    thisPhone: 'This phone',
    reduceMotionOn: 'Reduce motion is on',
    reduceMotionOff: 'Reduce motion is off',
    setYourselfOn: 'You have set this yourself, so it stays on whatever the phone says.',
    setYourselfOff: 'You have set this yourself, so it stays off whatever the phone says.',
    followingReduced: 'Following your accessibility settings, which ask for less movement.',
    following: 'Following your accessibility settings.',
    followPhone: "Follow my phone's setting",
    footnote:
      'Turning motion off does not shorten the animations — it removes them. A faster animation is still an animation to somebody who cannot watch one.',
  },
  lock: {
    title: 'Security',
    requireBiometrics: 'Require biometrics or a passcode',
    requireExplain:
      'Handing someone your phone to show them the split should not show them everything else.',
    appLock: 'App lock',
    unsupported: 'This device has no biometrics or passcode set up',
    askAgainAfter: 'Ask again after',
    askAgainExplain:
      'Time in the background before Baaki locks. Settling by UPI sends you to another app and back, so locking the instant you leave means unlocking every time you pay somebody.',
    graceImmediate: 'Straight away',
    graceSeconds: { one: 'After {n} second', other: 'After {n} seconds' },
    graceMinutes: { one: 'After a minute', other: 'After {n} minutes' },
    reopenAlwaysAsks: 'Reopening Baaki after it has been closed always asks, whatever this says.',
    signOut: 'Sign out',
    signOutGuest: 'This account lives on this device only. Signing out ends it.',
    signOutMember: 'Your groups and history stay exactly where they are.',
    signOutQuestion: 'Sign out?',
    signOutGuestWarning:
      'This is a guest account, so signing out leaves no way back into it. Add an email or phone number first if you want to keep it.',
    signOutReassure: 'You can sign back in whenever you like. Nothing is deleted.',
    staySignedIn: 'Stay signed in',
    footnote:
      'This guards the screen, not the data — your ledger is protected by row-level security on the server whether the lock is on or not.',
  },
  account: {
    faceYou: 'You',
    facePaying: 'Paying',
    faceSettings: 'Settings',
    settled: 'settled',
    nothingSettledYet: 'Nothing settled yet',
    otherCurrencies: { one: 'and {n} other currency', other: 'and {n} other currencies' },
    saved: 'Saved',
    displayName: 'Display name',
    you: 'You',
    guestAccount: 'Guest account',
    guestAccountBody:
      'Everything you have entered is already saved and yours. Add an email or phone number whenever you want to reach it from another phone — it keeps this account rather than starting a new one.',
    addYourDetails: 'Add your details',
    yourPhoto: 'Your photo',
    chooseNewPhoto: 'Choose a new one',
    howPeoplePayYou: 'How people pay you',
    yourRailDetails: 'Your {rail} details',
    handleWrong: 'That does not look like {hint}.',
    railLinkNote: 'People settling with you get a one-tap payment. Baaki never handles the money.',
    railManualNote:
      'People settling with you see this to pay you from their own bank app. Baaki never handles the money.',
    nothingToAdd: 'Nothing to add — people will record what they paid you by hand.',
    sectionBaaki: 'Baaki',
    sectionSettings: 'Settings',
    sectionSecurity: 'Security',
    upgradeHint: 'Nothing to buy yet — the ledger stays free',
    yourAccount: 'Your account',
    yourAccountHint: 'Add an email or phone, or carry on as a guest',
    notifications: 'Notifications',
    notificationsHint: 'Only what involves me',
    exportDataRow: 'Export data',
    exportHint: 'JSON + CSV, lossless, free',
    importSplitwise: 'Import from Splitwise',
    importHint: 'Bring a group across from a CSV export',
    motionRow: 'Motion',
    languageFollowingPhone: 'Following your phone — {language}',
    languageRestartHint: '{language} · reopen Baaki to mirror it',
    lockNoBiometrics: 'This device has no biometrics set up',
    lockOn: 'On · asks {when}',
    lockOff: 'Off — anyone holding your phone can read the ledger',
    signOutGuestHint: 'This guest account lives on this device only',
    signOutHint: 'Nothing is deleted; sign back in whenever',
    motionOn: 'Screen animations on',
    motionOff: 'Screen animations off',
    motionFollowingOn: 'Following your phone — animations on',
    motionFollowingOff: 'Following your phone — animations off',
    footnote: 'Baaki · the ledger is free forever. We only ever charge for convenience.',
  },
};

/**
 * No `...en` spread here, or in `hi` below.
 *
 * Spreading English first is what let twenty-nine keys sit untranslated for
 * three milestones: the table compiled, the test passed, and a Tamil phone
 * quietly showed "Pending confirmation" and "Get started" in English. Without
 * the spread, `UiStrings` being a closed interface means a new key is a
 * compile error in every language until somebody writes the words.
 */
const ta: UiStrings = {
  greeting: 'வணக்கம்',
  yourBaaki: 'உங்கள் பாக்கி',
  acrossGroups: '{count} குழுக்களில்',
  youAreOwed: 'உங்களுக்கு வர வேண்டியது',
  youOwe: 'நீங்கள் தர வேண்டியது',
  allSettled: 'எல்லாம் சரி',
  yourGroups: 'உங்கள் குழுக்கள்',
  newGroup: 'புதிய குழு',
  activity: 'செயல்பாடு',
  friends: 'நண்பர்கள்',
  profile: 'கணக்கு',
  home: 'முகப்பு',
  addExpense: 'செலவு சேர்',
  scanBill: 'ரசீது ஸ்கேன்',
  settleUp: 'தீர்ப்பது',
  simplify: 'எளிமையாக்கு',
  whoPaysWhom: 'யார் யாருக்குத் தர வேண்டும்',
  expenses: 'செலவுகள்',
  balances: 'இருப்பு',
  paidBy: 'கொடுத்தவர்',
  splitEqually: 'சமமாகப் பிரி',
  description: 'எதற்காக?',
  save: 'செலவைச் சேமி',
  pendingConfirmation: 'உறுதிப்படுத்தல் நிலுவையில்',
  toConfirm: 'உறுதிப்படுத்த வேண்டியவை',
  overallOwed: 'மொத்தத்தில் உங்களுக்கு வர வேண்டியது',
  overallOwe: 'நீங்கள் தர வேண்டிய பாக்கி',
  payViaUpi: 'UPI மூலம் செலுத்து',
  paidInCash: 'ரொக்கமாகக் கொடுத்தாயிற்று',
  bankOther: 'வங்கி / மற்றவை',
  perExpense: 'குறிப்பிட்ட செலவுகளுக்குப் பயன்படுத்து',
  members: 'உறுப்பினர்கள்',
  notJoinedYet: 'இன்னும் சேரவில்லை',
  scansLeft: 'ஸ்கேன் மீதம்',
  simplifyOn: 'எளிமையாக்கல் இயக்கத்தில்',
  simplifyOff: 'எளிமையாக்கல் நிறுத்தத்தில்',
  freeForever: 'எப்போதும் இலவசம்',
  nothingYet: 'இங்கே இன்னும் ஒன்றுமில்லை',
  nothingYetBody: 'முதல் செலவைச் சேருங்கள் — கணக்கு தானே பார்த்துக்கொள்ளும்.',
  whatFor: 'எந்த வகைச் செலவு',
  spending: 'செலவு',
  byCategory: 'எதற்குச் சென்றது',
  byMonth: 'மாதம் வாரியாக',
  nothingToChart: 'சில செலவுகளைச் சேர்த்தால் இது நிரம்பும்.',
  categories: {
    food: 'உணவு',
    groceries: 'மளிகை',
    travel: 'பயணம்',
    stay: 'தங்குமிடம்',
    shopping: 'ஷாப்பிங்',
    entertainment: 'பொழுதுபோக்கு',
    home: 'வீடு & பில்',
    health: 'உடல்நலம்',
    gifts: 'பரிசு',
    other: 'மற்றவை',
  },
  plan: 'திட்டம்',
  planned: 'திட்டமிட்டது',
  spent: 'செலவானது',
  overBudget: 'அதிகம்',
  underBudget: 'குறைவு',
  nothingPlannedYet: 'இன்னும் திட்டம் ஏதுமில்லை',
  planEmptyBody:
    'நாட்களையும் செய்யப் போவதையும் சேருங்கள். உண்மையில் ஆன செலவு தானே நிரம்பிக்கொள்ளும்.',
  whatIsPlanned: 'என்ன செய்யப் போகிறீர்கள்?',
  add: 'சேர்',
  cancel: 'ரத்து',
  whichGroup: 'எந்தக் குழுவுக்கு?',
  skip: 'தவிர்',
  next: 'அடுத்து',
  getStarted: 'தொடங்கலாம்',
  language: 'மொழி',
  upgrade: 'மேம்படுத்தல்',
  common: {
    back: 'பின்',
    close: 'மூடு',
    cancel: 'ரத்து',
    save: 'சேமி',
    edit: 'திருத்து',
    remove: 'நீக்கு',
    delete: 'அழி',
    share: 'பகிர்',
    done: 'முடிந்தது',
    guest: 'விருந்தினர்',
    name: 'பெயர்',
    yourName: 'உங்கள் பெயர்',
    emailOrPhone: 'மின்னஞ்சல் அல்லது தொலைபேசி எண்',
    notFound: 'கிடைக்கவில்லை',
    goBack: 'திரும்பிச் செல்',
  },
  onboarding: [
    {
      title: 'இரவு உணவு, வாடகை,\nஒரு முழுப் பயணம்',
      body: 'யார் கொடுத்தார்கள், யார் தர வேண்டும் என்பதைக் கடைசிக் காசு வரை பாக்கி வைத்திருக்கும் — இலவசம், முதலில் கணக்கு உருவாக்கத் தேவையில்லை.',
    },
    {
      title: 'ஒரு இணைப்பை அனுப்புங்கள்,\nஅவர்கள் உள்ளே',
      body: 'நீங்கள் பகிர்ந்துகொள்பவர்கள் எதையும் நிறுவத் தேவையில்லை. இணைப்பைத் திறந்தால் நீங்கள் பார்க்கும் அதே எண்களையே பார்ப்பார்கள்.',
    },
    {
      title: 'ஒரே தட்டில்\nதீர்த்து விடுங்கள்',
      body: 'சரியான தொகையை பாக்கி உங்கள் பணச் செயலிக்கே கொடுக்கும் — யாரும் இரண்டு முறை கணக்குப் போட வேண்டாம், யாருக்கும் சில்லறை பாக்கி நிற்காது.',
    },
  ],
  exportData: {
    title: 'உங்கள் தரவை ஏற்றுமதி செய்',
    everythingFree: 'எல்லாமே, எப்போதும் இலவசம்',
    noPaywall: 'கட்டணச் சுவர் இல்லை',
    explain:
      'JSON இல் ஒவ்வொரு செலவின் ஒவ்வொரு பதிப்பும், யார் கொடுத்தார்கள், யார் தர வேண்டும், தீர்வுகளும் அவற்றின் செலவு வாரியான பங்கீடும், செயல்பாட்டுப் பதிவும் இருக்கும் — உங்கள் கணக்கை அப்படியே மீண்டும் கட்ட இது போதும். CSV என்பது விரிதாள் பார்வை, ஆள் வாரியான தீர்வு விவரங்களுடன்.',
    format: 'வடிவம்',
    json: 'JSON (முழுமையானது)',
    csv: 'CSV (விரிதாள்)',
    whatToExport: 'எதை ஏற்றுமதி செய்ய',
    allMyGroups: 'என் குழுக்கள் அனைத்தும்',
    preparing: 'தயாராகிறது…',
    action: 'ஏற்றுமதி',
    ready: 'ஏற்றுமதி தயார்',
    webNote:
      'வலையில் கோப்பு ஆப்பின் தற்காலிக இடத்தில் எழுதப்படுகிறது; மேலும் பகிர ஒரு சாதனத்தைப் பயன்படுத்துங்கள்.',
    shareTitle: 'உங்கள் பாக்கி ஏற்றுமதி',
    importInstead: 'Splitwise இலிருந்து இறக்குமதி',
  },
  motion: {
    title: 'அசைவு',
    animateBetweenScreens: 'திரைகளுக்கு இடையே அசைவு',
    animateExplain:
      'திரைகள் வலமிருந்து நுழையும், தாள்கள் கீழிருந்து எழும் — நீங்கள் வேறு இடத்திற்குச் சென்றீர்களா அல்லது இருந்த இடத்தின் மேல் ஒன்றைத் திறந்தீர்களா என்பதை திரை இப்படித்தான் சொல்கிறது.',
    thisPhone: 'இந்த ஃபோன்',
    reduceMotionOn: 'அசைவைக் குறை இயக்கத்தில்',
    reduceMotionOff: 'அசைவைக் குறை நிறுத்தத்தில்',
    setYourselfOn:
      'இதை நீங்களே அமைத்துள்ளீர்கள், எனவே ஃபோன் என்ன சொன்னாலும் இயக்கத்திலேயே இருக்கும்.',
    setYourselfOff:
      'இதை நீங்களே அமைத்துள்ளீர்கள், எனவே ஃபோன் என்ன சொன்னாலும் நிறுத்தத்திலேயே இருக்கும்.',
    followingReduced: 'குறைவான அசைவைக் கேட்கும் உங்கள் அணுகல் அமைப்புகளைப் பின்பற்றுகிறது.',
    following: 'உங்கள் அணுகல் அமைப்புகளைப் பின்பற்றுகிறது.',
    followPhone: 'என் ஃபோனின் அமைப்பைப் பின்பற்று',
    footnote:
      'அசைவை நிறுத்துவது அசைவுகளைக் குறைப்பதில்லை — அவற்றை நீக்குகிறது. பார்க்க முடியாதவருக்கு வேகமான அசைவும் அசைவுதான்.',
  },
  lock: {
    title: 'பாதுகாப்பு',
    requireBiometrics: 'கைரேகை அல்லது கடவுக்குறியீடு கேட்கவும்',
    requireExplain:
      'பங்கீட்டைக் காட்ட ஃபோனைக் கொடுப்பது மற்ற எல்லாவற்றையும் காட்டுவதாக இருக்கக் கூடாது.',
    appLock: 'ஆப் பூட்டு',
    unsupported: 'இந்தச் சாதனத்தில் கைரேகையோ கடவுக்குறியீடோ அமைக்கப்படவில்லை',
    askAgainAfter: 'மீண்டும் கேட்க',
    askAgainExplain:
      'பாக்கி பூட்டப்படுவதற்கு முன் பின்னணியில் இருக்கும் நேரம். UPI மூலம் தீர்ப்பது உங்களை வேறு ஆப்புக்கு அனுப்பி மீண்டும் கொண்டுவரும், எனவே வெளியேறியதுமே பூட்டினால் ஒவ்வொரு முறை பணம் கொடுக்கும்போதும் திறக்க வேண்டியிருக்கும்.',
    graceImmediate: 'உடனடியாக',
    graceSeconds: { one: '{n} வினாடி கழித்து', other: '{n} வினாடிகள் கழித்து' },
    graceMinutes: { one: 'ஒரு நிமிடம் கழித்து', other: '{n} நிமிடங்கள் கழித்து' },
    reopenAlwaysAsks: 'பாக்கியை மூடிவிட்டுத் திறந்தால் இது என்னவாக இருந்தாலும் எப்போதும் கேட்கும்.',
    signOut: 'வெளியேறு',
    signOutGuest:
      'இந்தக் கணக்கு இந்தச் சாதனத்தில் மட்டுமே உள்ளது. வெளியேறினால் அது முடிந்துவிடும்.',
    signOutMember: 'உங்கள் குழுக்களும் வரலாறும் அப்படியே இருக்கும்.',
    signOutQuestion: 'வெளியேறவா?',
    signOutGuestWarning:
      'இது விருந்தினர் கணக்கு, வெளியேறினால் திரும்ப வர வழி இல்லை. வைத்திருக்க விரும்பினால் முதலில் மின்னஞ்சல் அல்லது தொலைபேசி எண்ணைச் சேர்க்கவும்.',
    signOutReassure: 'எப்போது வேண்டுமானாலும் மீண்டும் உள்நுழையலாம். எதுவும் அழிக்கப்படவில்லை.',
    staySignedIn: 'உள்ளேயே இரு',
    footnote:
      'இது திரையைக் காக்கிறது, தரவை அல்ல — பூட்டு இருந்தாலும் இல்லாவிட்டாலும் உங்கள் கணக்கு சர்வரில் வரிசை அளவிலான பாதுகாப்பால் காக்கப்படுகிறது.',
  },
  account: {
    faceYou: 'நீங்கள்',
    facePaying: 'பணம் பெற',
    faceSettings: 'அமைப்புகள்',
    settled: 'தீர்ந்தது',
    nothingSettledYet: 'இன்னும் எதுவும் தீரவில்லை',
    otherCurrencies: { one: 'மேலும் {n} நாணயம்', other: 'மேலும் {n} நாணயங்கள்' },
    saved: 'சேமிக்கப்பட்டது',
    displayName: 'காட்டப்படும் பெயர்',
    you: 'நீங்கள்',
    guestAccount: 'விருந்தினர் கணக்கு',
    guestAccountBody:
      'நீங்கள் சேர்த்தவை அனைத்தும் ஏற்கனவே சேமிக்கப்பட்டு உங்களுடையவை. வேறு ஃபோனிலிருந்து அணுக விரும்பும்போது மின்னஞ்சலையோ தொலைபேசி எண்ணையோ சேர்க்கவும் — புதிய கணக்கு தொடங்காமல் இதே கணக்கு தொடரும்.',
    addYourDetails: 'உங்கள் விவரங்களைச் சேர்',
    yourPhoto: 'உங்கள் புகைப்படம்',
    chooseNewPhoto: 'புதிதாக ஒன்றைத் தேர்ந்தெடு',
    howPeoplePayYou: 'உங்களுக்கு எப்படிப் பணம் தருவது',
    yourRailDetails: 'உங்கள் {rail} விவரங்கள்',
    handleWrong: 'இது {hint} போல் தெரியவில்லை.',
    railLinkNote:
      'உங்களுடன் தீர்ப்பவர்களுக்கு ஒரே தட்டில் பணம் அனுப்ப முடியும். பாக்கி பணத்தைக் கையாள்வதே இல்லை.',
    railManualNote:
      'உங்களுடன் தீர்ப்பவர்கள் இதைப் பார்த்து தங்கள் வங்கி ஆப்பிலிருந்து பணம் அனுப்புவார்கள். பாக்கி பணத்தைக் கையாள்வதே இல்லை.',
    nothingToAdd: 'சேர்க்க ஒன்றுமில்லை — கொடுத்ததை மற்றவர்கள் கையால் பதிவு செய்வார்கள்.',
    sectionBaaki: 'பாக்கி',
    sectionSettings: 'அமைப்புகள்',
    sectionSecurity: 'பாதுகாப்பு',
    upgradeHint: 'வாங்க இன்னும் ஒன்றுமில்லை — கணக்கு இலவசமாகவே இருக்கும்',
    yourAccount: 'உங்கள் கணக்கு',
    yourAccountHint: 'மின்னஞ்சல் அல்லது தொலைபேசியைச் சேர், அல்லது விருந்தினராகவே தொடர்',
    notifications: 'அறிவிப்புகள்',
    notificationsHint: 'என்னைச் சார்ந்தவை மட்டும்',
    exportDataRow: 'தரவை ஏற்றுமதி செய்',
    exportHint: 'JSON + CSV, முழுமையானது, இலவசம்',
    importSplitwise: 'Splitwise இலிருந்து இறக்குமதி',
    importHint: 'CSV ஏற்றுமதியிலிருந்து ஒரு குழுவைக் கொண்டுவா',
    motionRow: 'அசைவு',
    languageFollowingPhone: 'உங்கள் ஃபோனைப் பின்பற்றுகிறது — {language}',
    languageRestartHint: '{language} · பிரதிபலிக்க பாக்கியை மீண்டும் திற',
    lockNoBiometrics: 'இந்தச் சாதனத்தில் கைரேகை அமைக்கப்படவில்லை',
    lockOn: 'இயக்கத்தில் · {when} கேட்கும்',
    lockOff: 'நிறுத்தத்தில் — உங்கள் ஃபோனை வைத்திருப்பவர் யாரும் கணக்கைப் படிக்கலாம்',
    signOutGuestHint: 'இந்த விருந்தினர் கணக்கு இந்தச் சாதனத்தில் மட்டுமே உள்ளது',
    signOutHint: 'எதுவும் அழிக்கப்படாது; எப்போது வேண்டுமானாலும் மீண்டும் உள்நுழையலாம்',
    motionOn: 'திரை அசைவுகள் இயக்கத்தில்',
    motionOff: 'திரை அசைவுகள் நிறுத்தத்தில்',
    motionFollowingOn: 'உங்கள் ஃபோனைப் பின்பற்றுகிறது — அசைவுகள் இயக்கத்தில்',
    motionFollowingOff: 'உங்கள் ஃபோனைப் பின்பற்றுகிறது — அசைவுகள் நிறுத்தத்தில்',
    footnote: 'பாக்கி · கணக்கு எப்போதும் இலவசம். வசதிக்கு மட்டுமே நாங்கள் கட்டணம் வாங்குவோம்.',
  },
};

const hi: UiStrings = {
  greeting: 'नमस्ते',
  yourBaaki: 'आपकी बाकी',
  acrossGroups: '{count} समूहों में',
  youAreOwed: 'आपको मिलने हैं',
  youOwe: 'आपको देने हैं',
  allSettled: 'सब बराबर',
  yourGroups: 'आपके समूह',
  newGroup: 'नया समूह',
  activity: 'गतिविधि',
  friends: 'दोस्त',
  profile: 'खाता',
  home: 'होम',
  addExpense: 'खर्च जोड़ें',
  scanBill: 'बिल स्कैन',
  settleUp: 'हिसाब चुकाएँ',
  simplify: 'आसान करें',
  whoPaysWhom: 'कौन किसे देगा',
  expenses: 'खर्च',
  balances: 'बाकी',
  paidBy: 'भुगतान',
  splitEqually: 'बराबर बाँटें',
  description: 'किस लिए?',
  save: 'खर्च सेव करें',
  pendingConfirmation: 'पुष्टि बाकी',
  toConfirm: 'पुष्टि करनी है',
  overallOwed: 'कुल मिलाकर आपको मिलने हैं',
  overallOwe: 'आपकी देने की बाकी',
  payViaUpi: 'UPI से भुगतान',
  paidInCash: 'नकद दिया',
  bankOther: 'बैंक / अन्य',
  perExpense: 'कुछ खास खर्चों पर लगाएँ',
  members: 'सदस्य',
  notJoinedYet: 'अभी शामिल नहीं हुए',
  scansLeft: 'स्कैन बाकी',
  simplifyOn: 'आसान करना चालू',
  simplifyOff: 'आसान करना बंद',
  freeForever: 'हमेशा मुफ़्त',
  nothingYet: 'यहाँ अभी कुछ नहीं है',
  nothingYetBody: 'पहला खर्च जोड़िए, हिसाब अपने आप संभल जाएगा।',
  whatFor: 'किस तरह का खर्च',
  spending: 'खर्च',
  byCategory: 'कहाँ गया',
  byMonth: 'महीने के हिसाब से',
  nothingToChart: 'कुछ खर्च जोड़ें, यह अपने आप भर जाएगा।',
  categories: {
    food: 'खाना-पीना',
    groceries: 'किराना',
    travel: 'सफ़र',
    stay: 'ठहरना',
    shopping: 'शॉपिंग',
    entertainment: 'मनोरंजन',
    home: 'घर व बिल',
    health: 'सेहत',
    gifts: 'तोहफ़े',
    other: 'अन्य',
  },
  plan: 'योजना',
  planned: 'तय किया',
  spent: 'खर्च हुआ',
  overBudget: 'ज़्यादा',
  underBudget: 'कम',
  nothingPlannedYet: 'अभी कोई योजना नहीं',
  planEmptyBody: 'दिन और जो करना है वह जोड़िए। असल में जो लगा वह अपने आप भर जाएगा।',
  whatIsPlanned: 'क्या करना है?',
  add: 'जोड़ें',
  cancel: 'रद्द',
  whichGroup: 'किस समूह के लिए?',
  skip: 'छोड़ें',
  next: 'आगे',
  getStarted: 'शुरू करें',
  language: 'भाषा',
  upgrade: 'अपग्रेड',
  common: {
    back: 'वापस',
    close: 'बंद करें',
    cancel: 'रद्द करें',
    save: 'सेव करें',
    edit: 'बदलें',
    remove: 'हटाएँ',
    delete: 'मिटाएँ',
    share: 'साझा करें',
    done: 'हो गया',
    guest: 'मेहमान',
    name: 'नाम',
    yourName: 'आपका नाम',
    emailOrPhone: 'ईमेल या फ़ोन नंबर',
    notFound: 'नहीं मिला',
    goBack: 'वापस जाएँ',
  },
  onboarding: [
    {
      title: 'खाना, किराया,\nपूरी यात्रा',
      body: 'किसने दिया और किस पर कितना बाकी है — बाकी यह आख़िरी पैसे तक रखता है। मुफ़्त, और पहले खाता बनाने की ज़रूरत नहीं।',
    },
    {
      title: 'एक लिंक भेजिए,\nवे शामिल',
      body: 'जिनके साथ बाँट रहे हैं उन्हें कुछ भी इंस्टॉल नहीं करना। लिंक खोलिए और वही अंक दिखेंगे जो आपको दिखते हैं।',
    },
    {
      title: 'एक टैप में\nहिसाब बराबर',
      body: 'बाकी ठीक उतनी रकम आपके पेमेंट ऐप को दे देता है, ताकि कोई दोबारा जोड़-घटाव न करे और किसी का चिल्लर न रह जाए।',
    },
  ],
  exportData: {
    title: 'अपना डेटा निर्यात करें',
    everythingFree: 'सब कुछ, हमेशा मुफ़्त',
    noPaywall: 'कोई पेवॉल नहीं',
    explain:
      'JSON में हर खर्च का हर संस्करण, किसने दिया, किस पर बाकी था, निपटान और उनका खर्च-वार बँटवारा, और गतिविधि का पूरा ब्योरा होता है — आपका पूरा हिसाब हूबहू दोबारा बनाने के लिए काफ़ी। CSV स्प्रेडशीट वाला रूप है, जिसमें व्यक्ति-वार निपटान का ब्योरा भी है।',
    format: 'प्रारूप',
    json: 'JSON (कुछ छूटता नहीं)',
    csv: 'CSV (स्प्रेडशीट)',
    whatToExport: 'क्या निर्यात करें',
    allMyGroups: 'मेरे सभी समूह',
    preparing: 'तैयार हो रहा है…',
    action: 'निर्यात',
    ready: 'निर्यात तैयार है',
    webNote:
      'वेब पर फ़ाइल ऐप के कैश में लिखी जाती है; आगे साझा करने के लिए किसी डिवाइस का उपयोग करें।',
    shareTitle: 'आपका बाकी निर्यात',
    importInstead: 'Splitwise से आयात करें',
  },
  motion: {
    title: 'गति',
    animateBetweenScreens: 'स्क्रीनों के बीच एनिमेशन',
    animateExplain:
      'स्क्रीन दाईं ओर से आती हैं और शीट नीचे से उठती हैं — स्क्रीन इसी तरह बताती है कि आप कहीं गए हैं या जहाँ थे उसी के ऊपर कुछ खोला है।',
    thisPhone: 'यह फ़ोन',
    reduceMotionOn: 'गति कम करना चालू है',
    reduceMotionOff: 'गति कम करना बंद है',
    setYourselfOn: 'यह आपने खुद तय किया है, इसलिए फ़ोन कुछ भी कहे यह चालू ही रहेगा।',
    setYourselfOff: 'यह आपने खुद तय किया है, इसलिए फ़ोन कुछ भी कहे यह बंद ही रहेगा।',
    followingReduced: 'आपकी सुगम्यता सेटिंग्स के अनुसार, जो कम हलचल माँगती हैं।',
    following: 'आपकी सुगम्यता सेटिंग्स के अनुसार।',
    followPhone: 'मेरे फ़ोन की सेटिंग मानें',
    footnote:
      'गति बंद करने से एनिमेशन छोटे नहीं होते — वे हट जाते हैं। जो उन्हें देख नहीं सकता, उसके लिए तेज़ एनिमेशन भी एनिमेशन ही है।',
  },
  lock: {
    title: 'सुरक्षा',
    requireBiometrics: 'बायोमेट्रिक या पासकोड माँगें',
    requireExplain: 'हिसाब दिखाने के लिए फ़ोन थमाना बाकी सब कुछ दिखाना नहीं होना चाहिए।',
    appLock: 'ऐप लॉक',
    unsupported: 'इस डिवाइस पर बायोमेट्रिक या पासकोड सेट नहीं है',
    askAgainAfter: 'दोबारा पूछें',
    askAgainExplain:
      'बाकी के लॉक होने से पहले बैकग्राउंड में बीता समय। UPI से निपटाने पर आप दूसरे ऐप में जाकर लौटते हैं, इसलिए निकलते ही लॉक करने का मतलब है हर भुगतान पर दोबारा खोलना।',
    graceImmediate: 'तुरंत',
    graceSeconds: { one: '{n} सेकंड बाद', other: '{n} सेकंड बाद' },
    graceMinutes: { one: 'एक मिनट बाद', other: '{n} मिनट बाद' },
    reopenAlwaysAsks: 'बाकी को बंद करके दोबारा खोलने पर हमेशा पूछा जाएगा, यहाँ कुछ भी लिखा हो।',
    signOut: 'साइन आउट',
    signOutGuest: 'यह खाता सिर्फ़ इसी डिवाइस पर है। साइन आउट करने से यह खत्म हो जाएगा।',
    signOutMember: 'आपके समूह और इतिहास जहाँ हैं वहीं रहेंगे।',
    signOutQuestion: 'साइन आउट करें?',
    signOutGuestWarning:
      'यह मेहमान खाता है, साइन आउट करने पर वापस आने का कोई रास्ता नहीं बचेगा। इसे रखना है तो पहले ईमेल या फ़ोन नंबर जोड़ें।',
    signOutReassure: 'आप जब चाहें दोबारा साइन इन कर सकते हैं। कुछ भी मिटता नहीं।',
    staySignedIn: 'साइन इन रहें',
    footnote:
      'यह स्क्रीन की रक्षा करता है, डेटा की नहीं — लॉक चालू हो या बंद, आपका हिसाब सर्वर पर रो-लेवल सुरक्षा से सुरक्षित है।',
  },
  account: {
    faceYou: 'आप',
    facePaying: 'भुगतान',
    faceSettings: 'सेटिंग्स',
    settled: 'निपटा',
    nothingSettledYet: 'अभी कुछ नहीं निपटा',
    otherCurrencies: { one: 'और {n} अन्य मुद्रा', other: 'और {n} अन्य मुद्राएँ' },
    saved: 'सेव हो गया',
    displayName: 'दिखने वाला नाम',
    you: 'आप',
    guestAccount: 'मेहमान खाता',
    guestAccountBody:
      'आपने जो कुछ जोड़ा है वह पहले ही सेव है और आपका है। जब भी किसी दूसरे फ़ोन से पहुँचना हो, ईमेल या फ़ोन नंबर जोड़ लें — इससे नया खाता नहीं बनता, यही खाता बना रहता है।',
    addYourDetails: 'अपनी जानकारी जोड़ें',
    yourPhoto: 'आपकी फ़ोटो',
    chooseNewPhoto: 'नई चुनें',
    howPeoplePayYou: 'लोग आपको कैसे भुगतान करें',
    yourRailDetails: 'आपकी {rail} जानकारी',
    handleWrong: 'यह {hint} जैसा नहीं लगता।',
    railLinkNote: 'आपसे हिसाब करने वालों को एक टैप में भुगतान मिलता है। बाकी पैसा कभी नहीं छूता।',
    railManualNote:
      'आपसे हिसाब करने वाले इसे देखकर अपने बैंक ऐप से भुगतान करते हैं। बाकी पैसा कभी नहीं छूता।',
    nothingToAdd: 'जोड़ने को कुछ नहीं — लोग जो चुकाया है उसे खुद दर्ज करेंगे।',
    sectionBaaki: 'बाकी',
    sectionSettings: 'सेटिंग्स',
    sectionSecurity: 'सुरक्षा',
    upgradeHint: 'अभी खरीदने को कुछ नहीं — हिसाब मुफ़्त ही रहेगा',
    yourAccount: 'आपका खाता',
    yourAccountHint: 'ईमेल या फ़ोन जोड़ें, या मेहमान बने रहें',
    notifications: 'सूचनाएँ',
    notificationsHint: 'सिर्फ़ वही जिनसे मेरा वास्ता है',
    exportDataRow: 'डेटा निर्यात',
    exportHint: 'JSON + CSV, कुछ छूटता नहीं, मुफ़्त',
    importSplitwise: 'Splitwise से आयात',
    importHint: 'CSV निर्यात से कोई समूह ले आएँ',
    motionRow: 'गति',
    languageFollowingPhone: 'आपके फ़ोन के अनुसार — {language}',
    languageRestartHint: '{language} · दिशा बदलने के लिए बाकी दोबारा खोलें',
    lockNoBiometrics: 'इस डिवाइस पर बायोमेट्रिक सेट नहीं है',
    lockOn: 'चालू · {when} पूछता है',
    lockOff: 'बंद — आपका फ़ोन पकड़े कोई भी हिसाब पढ़ सकता है',
    signOutGuestHint: 'यह मेहमान खाता सिर्फ़ इसी डिवाइस पर है',
    signOutHint: 'कुछ मिटता नहीं; जब चाहें दोबारा साइन इन करें',
    motionOn: 'स्क्रीन एनिमेशन चालू',
    motionOff: 'स्क्रीन एनिमेशन बंद',
    motionFollowingOn: 'आपके फ़ोन के अनुसार — एनिमेशन चालू',
    motionFollowingOff: 'आपके फ़ोन के अनुसार — एनिमेशन बंद',
    footnote: 'बाकी · हिसाब हमेशा मुफ़्त है। हम सिर्फ़ सुविधा के पैसे लेते हैं।',
  },
};

/**
 * Gulf Arabic, not literary Arabic. "بَاقِي" is the app's own name and the
 * ordinary word for what is left over — the same pun the Tamil name is, which
 * is why it is not translated away here.
 */
const ar: UiStrings = {
  greeting: 'أهلاً',
  yourBaaki: 'باقيك',
  acrossGroups: 'في {count} مجموعات',
  youAreOwed: 'لك',
  youOwe: 'عليك',
  allSettled: 'تمت التسوية',
  yourGroups: 'مجموعاتك',
  newGroup: 'مجموعة جديدة',
  activity: 'النشاط',
  friends: 'الأصدقاء',
  profile: 'الحساب',
  home: 'الرئيسية',
  addExpense: 'إضافة مصروف',
  scanBill: 'مسح الفاتورة',
  settleUp: 'تسوية',
  simplify: 'تبسيط',
  whoPaysWhom: 'من يدفع لمن',
  expenses: 'المصروفات',
  balances: 'الأرصدة',
  paidBy: 'دفعها',
  splitEqually: 'تقسيم بالتساوي',
  description: 'على ماذا؟',
  save: 'حفظ المصروف',
  pendingConfirmation: 'بانتظار التأكيد',
  toConfirm: 'للتأكيد',
  overallOwed: 'لك إجمالاً',
  overallOwe: 'باقيك للدفع',
  payViaUpi: 'الدفع عبر UPI',
  paidInCash: 'دُفعت نقداً',
  bankOther: 'تحويل بنكي / غير ذلك',
  perExpense: 'تطبيق على مصروفات محددة',
  members: 'الأعضاء',
  notJoinedYet: 'لم ينضم بعد',
  scansLeft: 'عمليات مسح متبقية',
  simplifyOn: 'التبسيط مفعّل',
  simplifyOff: 'التبسيط متوقف',
  freeForever: 'بلا حدود ومجاني، للأبد',
  nothingYet: 'لا شيء هنا بعد',
  nothingYetBody: 'أضف أول مصروف والحساب يتكفل بنفسه.',
  whatFor: 'نوع المصروف',
  spending: 'الإنفاق',
  byCategory: 'أين ذهبت',
  byMonth: 'شهراً بشهر',
  nothingToChart: 'أضف بعض المصروفات وسيمتلئ هذا.',
  categories: {
    food: 'طعام وشراب',
    groceries: 'بقالة',
    travel: 'تنقّل',
    stay: 'إقامة',
    shopping: 'تسوّق',
    entertainment: 'ترفيه',
    home: 'المنزل والفواتير',
    health: 'صحة',
    gifts: 'هدايا',
    other: 'أخرى',
  },
  plan: 'الخطة',
  planned: 'المخطط',
  spent: 'المصروف',
  overBudget: 'زيادة',
  underBudget: 'أقل',
  nothingPlannedYet: 'لا خطة بعد',
  planEmptyBody: 'أضف الأيام وما تنوي فعله. أما التكلفة الفعلية فتُملأ من تلقاء نفسها.',
  whatIsPlanned: 'ماذا ستفعل؟',
  add: 'إضافة',
  cancel: 'إلغاء',
  whichGroup: 'لأي مجموعة؟',
  skip: 'تخطٍ',
  next: 'التالي',
  getStarted: 'لنبدأ',
  language: 'اللغة',
  upgrade: 'الترقية',
  common: {
    back: 'رجوع',
    close: 'إغلاق',
    cancel: 'إلغاء',
    save: 'حفظ',
    edit: 'تعديل',
    remove: 'إزالة',
    delete: 'حذف',
    share: 'مشاركة',
    done: 'تم',
    guest: 'ضيف',
    name: 'الاسم',
    yourName: 'اسمك',
    emailOrPhone: 'البريد الإلكتروني أو رقم الهاتف',
    notFound: 'غير موجود',
    goBack: 'العودة',
  },
  onboarding: [
    {
      title: 'عشاء، إيجار،\nرحلة كاملة',
      body: 'باقي يحفظ من دفع ومن عليه، بالفلس الواحد — مجاناً، وبدون إنشاء حساب أولاً.',
    },
    {
      title: 'أرسل رابطاً،\nوانضموا',
      body: 'من تقتسم معهم لا يحتاجون تثبيت أي شيء. يفتحون الرابط ويرون نفس الأرقام التي تراها.',
    },
    {
      title: 'سوِّ الحساب\nبضغطة واحدة',
      body: 'باقي يمرّر المبلغ بالضبط إلى تطبيق الدفع لديك، فلا أحد يحسب مرتين ولا أحد يخسر كسراً.',
    },
  ],
  exportData: {
    title: 'تصدير بياناتك',
    everythingFree: 'كل شيء، مجانًا دائمًا',
    noPaywall: 'بلا جدار دفع',
    explain:
      'يتضمن JSON كل نسخة من كل مصروف، ومن دفع، ومن عليه، والتسويات مع توزيعها على كل مصروف، وسجل النشاط — بما يكفي لإعادة بناء دفترك تمامًا. أما CSV فهو العرض الجدولي، ويشمل تفاصيل التسوية لكل شخص.',
    format: 'الصيغة',
    json: 'JSON (بلا فقدان)',
    csv: 'CSV (جدول بيانات)',
    whatToExport: 'ما الذي تريد تصديره',
    allMyGroups: 'كل مجموعاتي',
    preparing: 'جارٍ التحضير…',
    action: 'تصدير',
    ready: 'التصدير جاهز',
    webNote: 'على الويب يُكتب الملف في ذاكرة التطبيق المؤقتة؛ استخدم جهازًا لمشاركته.',
    shareTitle: 'تصدير باقي الخاص بك',
    importInstead: 'استيراد من Splitwise',
  },
  motion: {
    title: 'الحركة',
    animateBetweenScreens: 'حركة بين الشاشات',
    animateExplain:
      'تنزلق الشاشات من الجانب، وترتفع الأوراق من الأسفل — وهكذا تخبرك الشاشة إن كنت قد انتقلت إلى مكان آخر أم فتحت شيئًا فوق ما كنت فيه.',
    thisPhone: 'هذا الهاتف',
    reduceMotionOn: 'تقليل الحركة مفعّل',
    reduceMotionOff: 'تقليل الحركة غير مفعّل',
    setYourselfOn: 'لقد ضبطت هذا بنفسك، فسيبقى مفعّلًا مهما قال الهاتف.',
    setYourselfOff: 'لقد ضبطت هذا بنفسك، فسيبقى متوقفًا مهما قال الهاتف.',
    followingReduced: 'يتبع إعدادات تسهيل الوصول لديك، وهي تطلب حركة أقل.',
    following: 'يتبع إعدادات تسهيل الوصول لديك.',
    followPhone: 'اتبع إعداد هاتفي',
    footnote:
      'إيقاف الحركة لا يجعل الحركات أقصر — بل يزيلها. الحركة السريعة تظل حركة لمن لا يستطيع مشاهدتها.',
  },
  lock: {
    title: 'الأمان',
    requireBiometrics: 'اطلب البصمة أو رمز المرور',
    requireExplain: 'إعطاء هاتفك لأحد كي يرى التقسيم لا ينبغي أن يريه كل شيء آخر.',
    appLock: 'قفل التطبيق',
    unsupported: 'لا توجد بصمة أو رمز مرور مضبوط على هذا الجهاز',
    askAgainAfter: 'اسأل مرة أخرى بعد',
    askAgainExplain:
      'المدة في الخلفية قبل أن يُقفل باقي. التسوية عبر UPI تنقلك إلى تطبيق آخر ثم تعيدك، فالقفل لحظة الخروج يعني فتح القفل مع كل دفعة.',
    graceImmediate: 'فورًا',
    graceSeconds: {
      zero: 'بعد {n} ثانية',
      one: 'بعد ثانية',
      two: 'بعد ثانيتين',
      few: 'بعد {n} ثوانٍ',
      many: 'بعد {n} ثانية',
      other: 'بعد {n} ثانية',
    },
    graceMinutes: {
      zero: 'بعد {n} دقيقة',
      one: 'بعد دقيقة',
      two: 'بعد دقيقتين',
      few: 'بعد {n} دقائق',
      many: 'بعد {n} دقيقة',
      other: 'بعد {n} دقيقة',
    },
    reopenAlwaysAsks: 'إعادة فتح باقي بعد إغلاقه تطلب التحقق دائمًا، مهما كان هذا الإعداد.',
    signOut: 'تسجيل الخروج',
    signOutGuest: 'هذا الحساب موجود على هذا الجهاز فقط. تسجيل الخروج ينهيه.',
    signOutMember: 'مجموعاتك وسجلك يبقيان كما هما تمامًا.',
    signOutQuestion: 'تسجيل الخروج؟',
    signOutGuestWarning:
      'هذا حساب ضيف، وتسجيل الخروج لا يترك طريقًا للعودة إليه. أضف بريدًا إلكترونيًا أو رقم هاتف أولًا إن أردت الاحتفاظ به.',
    signOutReassure: 'يمكنك تسجيل الدخول متى شئت. لا يُحذف شيء.',
    staySignedIn: 'ابقَ مسجّل الدخول',
    footnote:
      'هذا يحمي الشاشة لا البيانات — دفترك محمي على الخادم بأمان على مستوى الصفوف سواء كان القفل مفعّلًا أم لا.',
  },
  account: {
    faceYou: 'أنت',
    facePaying: 'الدفع',
    faceSettings: 'الإعدادات',
    settled: 'تمت تسويته',
    nothingSettledYet: 'لم تتم تسوية شيء بعد',
    otherCurrencies: {
      zero: 'و{n} عملة أخرى',
      one: 'وعملة أخرى',
      two: 'وعملتان أخريان',
      few: 'و{n} عملات أخرى',
      many: 'و{n} عملة أخرى',
      other: 'و{n} عملة أخرى',
    },
    saved: 'تم الحفظ',
    displayName: 'الاسم الظاهر',
    you: 'أنت',
    guestAccount: 'حساب ضيف',
    guestAccountBody:
      'كل ما أدخلته محفوظ بالفعل وهو ملكك. أضف بريدًا إلكترونيًا أو رقم هاتف متى أردت الوصول إليه من هاتف آخر — سيحتفظ بهذا الحساب بدل أن يبدأ حسابًا جديدًا.',
    addYourDetails: 'أضف بياناتك',
    yourPhoto: 'صورتك',
    chooseNewPhoto: 'اختر صورة جديدة',
    howPeoplePayYou: 'كيف يدفع لك الناس',
    yourRailDetails: 'بيانات {rail} الخاصة بك',
    handleWrong: 'هذا لا يبدو مثل {hint}.',
    railLinkNote: 'من يسوّي معك يدفع بضغطة واحدة. باقي لا يلمس المال أبدًا.',
    railManualNote: 'من يسوّي معك يرى هذا ليدفع لك من تطبيق مصرفه. باقي لا يلمس المال أبدًا.',
    nothingToAdd: 'لا شيء تضيفه — سيسجّل الناس ما دفعوه لك يدويًا.',
    sectionBaaki: 'باقي',
    sectionSettings: 'الإعدادات',
    sectionSecurity: 'الأمان',
    upgradeHint: 'لا شيء للشراء بعد — الدفتر يبقى مجانيًا',
    yourAccount: 'حسابك',
    yourAccountHint: 'أضف بريدًا أو هاتفًا، أو تابع كضيف',
    notifications: 'الإشعارات',
    notificationsHint: 'ما يخصّني فقط',
    exportDataRow: 'تصدير البيانات',
    exportHint: 'JSON + CSV، بلا فقدان، مجانًا',
    importSplitwise: 'استيراد من Splitwise',
    importHint: 'أحضر مجموعة من ملف CSV مُصدَّر',
    motionRow: 'الحركة',
    languageFollowingPhone: 'يتبع هاتفك — {language}',
    languageRestartHint: '{language} · أعد فتح باقي لعكس الاتجاه',
    lockNoBiometrics: 'لا توجد بصمة مضبوطة على هذا الجهاز',
    lockOn: 'مفعّل · يسأل {when}',
    lockOff: 'متوقف — أي شخص يمسك هاتفك يمكنه قراءة الدفتر',
    signOutGuestHint: 'حساب الضيف هذا موجود على هذا الجهاز فقط',
    signOutHint: 'لا يُحذف شيء؛ سجّل الدخول متى شئت',
    motionOn: 'حركات الشاشة مفعّلة',
    motionOff: 'حركات الشاشة متوقفة',
    motionFollowingOn: 'يتبع هاتفك — الحركات مفعّلة',
    motionFollowingOff: 'يتبع هاتفك — الحركات متوقفة',
    footnote: 'باقي · الدفتر مجاني إلى الأبد. لا نتقاضى إلا مقابل الراحة.',
  },
};

const STRINGS: Record<Language, UiStrings> = { en, ta, hi, ar };

/**
 * The tables themselves, so a test can check that every language says
 * everything. A missing key is not a crash — it is `undefined` rendered as a
 * blank on one screen in one language, which is exactly the kind of thing that
 * ships.
 */
export const STRINGS_BY_LANGUAGE = STRINGS;

export function deviceLanguage(): Language {
  const tag = getLocales()[0]?.languageCode ?? 'en';
  return tag === 'ta' || tag === 'hi' || tag === 'ar' ? tag : 'en';
}

/**
 * Whether this phone reads right to left.
 *
 * Taken from the language rather than from `I18nManager.isRTL`, so it is the
 * same answer on web — where there is no `I18nManager` worth asking and the
 * root view is given a `dir` instead.
 */
export function isRtl(): boolean {
  return RTL_LANGUAGES.includes(deviceLanguage());
}

export function deviceLocale(): string {
  return getLocales()[0]?.languageTag ?? 'en-IN';
}

/**
 * Which country this phone thinks it is in, as ISO-3166 alpha-2, or null.
 *
 * Used to start a new group on the right payment rails and currency. It is the
 * *region* of the locale, not the language: somebody in Dubai reading the app
 * in Hindi is in AE, and guessing IN from `hi` would put them on UPI.
 *
 * Null rather than a fallback. A group with no country still works, and a
 * confident wrong answer is worse than no answer — it gets missed.
 */
export function deviceCountry(): string | null {
  const region = getLocales()[0]?.regionCode ?? null;
  return region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : null;
}

/**
 * The locale to format money and dates in, once somebody has chosen a language
 * their phone is not set to.
 *
 * The language changes; the region does not. Somebody in Dubai reading the app
 * in Hindi is still in the UAE — dates and currency belong to where they are,
 * not to what they read. So this swaps the language subtag and keeps the rest,
 * which is exactly what `hi-AE` means.
 *
 * Not called at all when the language is following the phone: there the phone's
 * own locale tag is richer than anything reassembled here, and reassembling it
 * would throw away a calendar or numbering system somebody had chosen.
 */
export function localeFor(language: Language): string {
  const region = deviceCountry();
  return region ? `${language}-${region}` : language;
}

/**
 * The chosen language, or null while nothing has provided one.
 *
 * Null is not a bug: `useStrings` is called from screens that render before the
 * provider is mounted and from tests that never mount it, and both should get
 * the phone's language rather than an exception.
 */
export const LanguageContext = createContext<{ language: Language; locale: string } | null>(null);

export function useStrings(): { t: UiStrings; locale: string; language: Language } {
  const chosen = useContext(LanguageContext);
  const language = chosen?.language ?? deviceLanguage();
  return { t: STRINGS[language], locale: chosen?.locale ?? deviceLocale(), language };
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
}
