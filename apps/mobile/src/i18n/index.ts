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
    ok: string;
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
    languageRestartHintBack: string;
    restartTitle: string;
    restartBannerMirror: string;
    restartBannerUnmirror: string;
    languageFooterNote: string;
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
  /** Notification preferences, and what the phone will and will not allow. */
  notifications: {
    title: string;
    neverSpam: string;
    onThisPhone: string;
    permissionOn: string;
    permissionOff: string;
    permissionUnset: string;
    granted: string;
    denied: string;
    undetermined: string;
    asking: string;
    turnOn: string;
    pushSection: string;
    involvesMe: string;
    involvesMeBody: string;
    settlementRequests: string;
    settlementRequestsBody: string;
    nudges: string;
    nudgesBody: string;
    digest: string;
    digestBody: string;
    weeklyEmail: string;
    weeklyEmailBody: string;
    failDenied: string;
    failUnsupported: string;
    failNotSignedIn: string;
    failNotConfigured: string;
    failSaveFailed: string;
    footnote: string;
  };
  /** Attaching an email or phone to the account you already have (ADR-006). */
  contact: {
    title: string;
    signedIn: string;
    guestBody: string;
    memberBody: string;
    email: string;
    phone: string;
    alreadyAdded: string;
    emailAddress: string;
    phoneNumber: string;
    emailPlaceholder: string;
    phonePlaceholder: string;
    codeEmailed: string;
    codeTexted: string;
    verificationCode: string;
    confirm: string;
    sendCodeEmail: string;
    sendCodePhone: string;
    useDifferent: string;
    added: string;
    footnote: string;
  };
  /** The welcome and the ways in (ADR-006: nobody registers to split a bill). */
  signIn: {
    tagline: string;
    splitAnything: string;
    welcomeBody: string;
    startNow: string;
    haveAccount: string;
    welcomeBack: string;
    keepOnNextPhone: string;
    guestAddWay: string;
    signInHowever: string;
    sendMeACode: string;
    useAPassword: string;
    phoneNumber: string;
    countryCodeHint: string;
    sendCode: string;
    codeSentTo: string;
    verify: string;
    differentNumber: string;
    identifier: string;
    identifierPlaceholder: string;
    password: string;
    passwordHint: string;
    addToAccount: string;
    createAccount: string;
    signInAction: string;
    switchToSignIn: string;
    switchToSignUp: string;
    continueGoogle: string;
    signInGoogle: string;
    continueGuest: string;
    guestFootnote: string;
    memberFootnote: string;
    restartToMirror: string;
    restartToUnmirror: string;
  };
  /** The three tabs, and the inbox behind the bell. */
  tabs: {
    guestBanner: string;
    guestBannerBody: string;
    addYourDetails: string;
    loadingGroups: string;
    noGroups: string;
    noGroupsBody: string;
    activityEmptyBody: string;
    inbox: string;
    fromContacts: string;
    allSquare: string;
    allSquareBody: string;
    owesYou: string;
    youOweThem: string;
    nobodyOwesYou: string;
    youAreNotBehind: string;
    inOneGroup: string;
    acrossGroups: PluralForms;
    notJoined: string;
    group: string;
  };
  /** The inbox — the record of what Baaki said, whether or not push arrived. */
  inbox: {
    title: string;
    nothingYetBody: string;
    recent: string;
  };
  /** A group: its screen, its settings, and the ways out of it. */
  group: {
    notFound: string;
    notFoundBody: string;
    notFoundArchived: string;
    loading: string;
    settings: string;
    mismatch: string;
    mismatchBody: string;
    confirmReceived: string;
    autoConfirms: string;
    hideDeleted: string;
    showDeleted: string;
    activityEmptyBody: string;
    photoUpdated: string;
    nameOptional: string;
    groupName: string;
    saveName: string;
    removePhoto: string;
    simplifyDebts: string;
    simplifyDebtsBody: string;
    membersHint: string;
    invitePeople: string;
    invitePeopleHint: string;
    bringThingsIn: string;
    importMessages: string;
    importMessagesHint: string;
    importSplitwise: string;
    importSplitwiseHint: string;
    archiveGroup: string;
    leaveGroup: string;
    leaveWhenZero: string;
    settleFirst: string;
    settleFirstBody: string;
    leaveQuestion: string;
    leaveBody: string;
    leave: string;
    archiveQuestion: string;
    archiveBody: string;
    archive: string;
    nobodyOwes: string;
    recordedNotMoved: string;
  };
  /** The people in a group, and the link that brings more in. */
  people: {
    invite: string;
    addSomeone: string;
    namePlaceholder: string;
    contactPlaceholder: string;
    yetToJoin: PluralForms;
    sendInviteLink: string;
    memberNotFound: string;
    memberNotFoundBody: string;
    admin: string;
    you: string;
    memberName: string;
    ghostNote: string;
    upiForGroup: string;
    upiForGroupNote: string;
    inviteTitle: string;
    anyoneWithLink: string;
    anyoneWithLinkBody: string;
    inviteLink: string;
    whatsapp: string;
    shareAnotherWay: string;
    copyLink: string;
    createLink: string;
    linkCopied: string;
    expires: string;
    hideContacts: string;
    browseContacts: string;
  };
  /** Adding and editing an expense, and reading one off a bill. */
  expense: {
    edit: string;
    chooseWhoPaid: string;
    editingKeepsVersion: string;
    splitByItem: string;
    scanBillTitle: string;
    scanBillBody: string;
    scan: string;
    reading: string;
    scanReconciles: string;
    scanCheckTotal: string;
    descriptionPlaceholder: string;
    howToSplit: string;
    equally: string;
    shares: string;
    percent: string;
    splitBetween: string;
    ofCount: string;
    saveChanges: string;
    notFound: string;
    notFoundBody: string;
    deleteQuestion: string;
    deleteBody: string;
    deleted: string;
    whoOwesWhat: string;
    history: string;
    restore: string;
    deleteAction: string;
    splitEqually: string;
    exactAmounts: string;
    byPercentage: string;
    byShares: string;
    withAdjustments: string;
    itemized: string;
  };
  /** Starting a group, joining one by link, and the odds and ends around both. */
  misc: {
    newGroupPlaceholder: string;
    personName: string;
    createGroup: string;
    linkExpired: string;
    linkExpiredBody: string;
    linkMissingCode: string;
    goToBaaki: string;
    freeNoAccount: string;
    isOneOfTheseYou: string;
    unnamed: string;
    joinAndClaim: string;
    joinGroup: string;
    fromYourContacts: string;
    continueWith: string;
    noAddress: string;
    addToWhichGroup: string;
    addThemAllToWhichGroup: string;
    startAGroup: string;
    pickDifferentPeople: string;
    someone: string;
    serverRefused: string;
    offlineSaved: string;
    notAnAmount: string;
    notARate: string;
    paidAnotherCurrency: string;
    whatIWasCharged: string;
    askingRate: string;
    getTodaysRate: string;
    micPermission: string;
    micBlocked: string;
    dictationFailed: string;
    stopDictating: string;
    dictateNote: string;
    updateBaaki: string;
    alreadyUpdated: string;
    update: string;
    notNow: string;
    changeGroupPhoto: string;
    addGroupPhoto: string;
    changeYourPhoto: string;
    addYourPhoto: string;
    followMyPhone: string;
    currentlyLanguage: string;
    rightToLeft: string;
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
    ok: 'OK',
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
    languageRestartHintBack: '{language} · reopen Baaki to turn the layout back',
    restartTitle: 'Close and open Baaki again',
    restartBannerMirror:
      'The words have changed already. Mirroring the layout — the arrows, the sides everything sits on — is something the phone decides when the app starts, so it takes effect next time you open it.',
    restartBannerUnmirror:
      'The words have changed already. Turning the mirrored layout back the other way is something the phone decides when the app starts, so it takes effect next time you open it.',
    languageFooterNote:
      "Your phone's language is the default, and choosing one here only changes Baaki. Amounts and dates still follow where you are — reading the app in Hindi in Dubai does not move you to India.",
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
  notifications: {
    title: 'Notifications',
    neverSpam:
      'Baaki never emails you about routine expense activity. Only the six things you would actually want in your inbox, each unsubscribable on its own.',
    onThisPhone: 'Notifications on this phone',
    permissionOn:
      'This device is registered. Everything below still lands in your inbox whether or not a push gets through.',
    permissionOff:
      'Your phone is blocking them. Turn them back on in system settings for Baaki — the inbox still has everything either way.',
    permissionUnset: 'Baaki will only ask once, and only for the things you switch on below.',
    granted: 'On',
    denied: 'Off',
    undetermined: 'Not set',
    asking: 'Asking…',
    turnOn: 'Turn on notifications',
    pushSection: 'Push',
    involvesMe: 'Only what involves me',
    involvesMeBody:
      'Push when you owe, are owed, or are mentioned — not for every expense in every group.',
    settlementRequests: 'Settlement confirmations',
    settlementRequestsBody: 'When someone says they paid you, so your baaki stays right.',
    nudges: 'Reminders',
    nudgesBody:
      'A friendly nudge about money owed. Limited to one per person per day, in the database.',
    digest: 'Daily group summary',
    digestBody: 'Everything else, batched into one notification a day instead of a stream.',
    weeklyEmail: 'Weekly email digest',
    weeklyEmailBody: 'Your net baaki and pending confirmations, once a week. Off by default.',
    failDenied: 'Not enabled — you can turn it on in your phone settings later.',
    failUnsupported:
      'This device cannot receive push notifications. Everything still lands in Activity.',
    failNotSignedIn: 'Sign in first, so we know which phone is yours.',
    failNotConfigured:
      'Push is not set up in this build of Baaki. Nothing you did — everything still lands in Activity.',
    failSaveFailed: 'Could not save this phone. Check your connection and try again.',
    footnote:
      'Email delivery is still to come. Everything here is also in your inbox, which is the record of what Baaki has told you whether or not a notification arrived.',
  },
  contact: {
    title: 'Your account',
    signedIn: 'Signed in',
    guestBody:
      'Everything you have entered is already saved and yours. Adding an email or phone number is only so you can get back to it from another phone.',
    memberBody: 'This account is reachable from any device you sign in on.',
    email: 'Email',
    phone: 'Phone',
    alreadyAdded: 'Already added: {value}',
    emailAddress: 'Email address',
    phoneNumber: 'Phone number',
    emailPlaceholder: 'you@example.com',
    phonePlaceholder: '+91 98765 43210',
    codeEmailed: 'Enter the six-digit code we emailed you',
    codeTexted: 'Enter the six-digit code we texted you',
    verificationCode: 'Verification code',
    confirm: 'Confirm',
    sendCodeEmail: 'Send me a code',
    sendCodePhone: 'Text me a code',
    useDifferent: 'Use a different one',
    added: 'Added. You can sign in with it on another phone now.',
    footnote:
      'Baaki never asks for this to let you in, and never shares it with anyone in your groups. People see the name you choose, nothing else.',
  },
  signIn: {
    tagline: 'baaki · what is left over',
    splitAnything: 'Split anything\nwith anyone',
    welcomeBody:
      'No account needed to start — add one later and everything you have entered comes with you.',
    startNow: 'Start now',
    haveAccount: 'I already have an account',
    welcomeBack: 'Welcome back',
    keepOnNextPhone: 'Keep this account on your next phone',
    guestAddWay: 'Add a way to sign in, so this account is still yours on your next phone.',
    signInHowever: 'Sign in however you set it up.',
    sendMeACode: 'Send me a code',
    useAPassword: 'Use a password',
    phoneNumber: 'Phone number',
    countryCodeHint:
      'Start with your country code. Baaki never assumes +91 — a trip is exactly when foreign numbers turn up.',
    sendCode: 'Send code',
    codeSentTo: 'Code sent to {value}',
    verify: 'Verify',
    differentNumber: 'Use a different number',
    identifier: 'Email or phone number',
    identifierPlaceholder: 'asha@example.com or +91…',
    password: 'Password',
    passwordHint:
      'Eight characters or more. A phrase you will remember beats a puzzle you will not.',
    addToAccount: 'Add this to my account',
    createAccount: 'Create account',
    signInAction: 'Sign in',
    switchToSignIn: 'I already have an account',
    switchToSignUp: 'I am new here — create an account',
    continueGoogle: 'Continue with Google',
    signInGoogle: 'Sign in with Google',
    continueGuest: 'Continue as guest',
    guestFootnote:
      'Everything you have already added stays exactly where it is. This only adds a way to sign back in.',
    memberFootnote:
      'A guest account keeps everything on this device until you add a way to sign in. Your ledger is never held hostage.',
    restartToMirror: 'Close and open Baaki once to mirror the layout.',
    restartToUnmirror: 'Close and open Baaki once to turn the layout back.',
  },
  tabs: {
    guestBanner: 'You are using Baaki as a guest',
    guestBannerBody:
      'Nothing is missing — everything you enter is saved and yours. Add an email or phone number whenever you want to reach it from another phone.',
    addYourDetails: 'Add your details',
    loadingGroups: 'Loading your groups…',
    noGroups: 'No groups yet',
    noGroupsBody:
      'Start one for a trip, a flat, or the two of you. Adding expenses is free and unlimited, forever.',
    activityEmptyBody:
      'Every expense, edit, deletion and settlement lands here — for everyone in the group.',
    inbox: 'Inbox',
    fromContacts: 'From contacts',
    allSquare: 'All square',
    allSquareBody:
      'Nobody owes you anything and you owe nobody. Friends you are settling up with will appear here — add somebody from your contacts to get started.',
    owesYou: 'Owes you',
    youOweThem: 'You owe',
    nobodyOwesYou: 'Nobody owes you anything right now.',
    youAreNotBehind: 'You are not behind with anyone.',
    inOneGroup: 'in one group',
    acrossGroups: { one: 'across {n} group', other: 'across {n} groups' },
    notJoined: 'Not joined',
    group: 'Group',
  },
  inbox: {
    title: 'Inbox',
    nothingYetBody:
      'Reminders, settlement confirmations and anything else Baaki tells you collect here — even when the notification never reached your phone.',
    recent: 'Recent',
  },
  group: {
    notFound: 'Group not found',
    notFoundBody: 'It may have been archived, or you are no longer a member.',
    notFoundArchived: 'It may have been archived.',
    loading: 'Loading…',
    settings: 'Group settings',
    mismatch: 'Balances need a refresh',
    mismatchBody:
      'This device and the server disagree about this group’s balances. Pull to refresh; if it persists, the ledger below is the source of truth.',
    confirmReceived: 'Confirm received',
    autoConfirms: 'Auto-confirms in 7 days if nobody responds.',
    hideDeleted: 'Hide deleted',
    showDeleted: 'Show deleted',
    activityEmptyBody: 'Everything that happens here shows up in this feed.',
    photoUpdated: 'Photo updated',
    nameOptional: 'Name (optional)',
    groupName: 'Group name',
    saveName: 'Save name',
    removePhoto: 'Remove photo',
    simplifyDebts: 'Simplify debts',
    simplifyDebtsBody:
      'Suggest the fewest payments that settle the group. The real who-owes-whom ledger is never rewritten.',
    membersHint: 'Add people, rename, set UPI IDs',
    invitePeople: 'Invite people',
    invitePeopleHint: 'Share a link — no install needed to join',
    bringThingsIn: 'Bring things in',
    importMessages: 'Import from messages',
    importMessagesHint: 'Paste bank messages — read on this phone, confirmed by you',
    importSplitwise: 'Import a Splitwise export',
    importSplitwiseHint: 'Bring an old group’s history across',
    archiveGroup: 'Archive group',
    leaveGroup: 'Leave group',
    leaveWhenZero: 'You can leave once your balance here is zero.',
    settleFirst: 'Settle up first',
    settleFirstBody:
      'You still have a balance in this group. Leaving now would strand it — settle up, then leave.',
    leaveQuestion: 'Leave this group?',
    leaveBody: 'Your past expenses stay in the group history.',
    leave: 'Leave',
    archiveQuestion: 'Archive this group?',
    archiveBody:
      'It disappears from your list but nothing is deleted, and anyone can unarchive it.',
    archive: 'Archive',
    nobodyOwes: 'Nobody owes anybody in this group.',
    recordedNotMoved: 'Recorded, not moved by Baaki',
  },
  people: {
    invite: 'Invite',
    addSomeone: 'Add someone',
    namePlaceholder: 'Rahul',
    contactPlaceholder: 'Email or phone, if you want to send them the link',
    yetToJoin: { one: '{n} yet to join', other: '{n} yet to join' },
    sendInviteLink: 'Send an invite link',
    memberNotFound: 'Member not found',
    memberNotFoundBody: 'They may have left the group.',
    admin: 'admin',
    you: 'you',
    memberName: 'Member name',
    ghostNote: 'This person holds real balances. When they join, they can claim this history.',
    upiForGroup: 'UPI ID for this group',
    upiForGroupNote:
      'Overrides your account UPI ID here only — useful when one group settles to a different account.',
    inviteTitle: 'Invite people',
    anyoneWithLink: 'Anyone with the link can join',
    anyoneWithLinkBody:
      'They do not need to install anything or make an account to see the group and add expenses.',
    inviteLink: 'Invite link',
    whatsapp: 'WhatsApp',
    shareAnotherWay: 'Share another way',
    copyLink: 'Copy link',
    createLink: 'Create an invite link',
    linkCopied: 'Link copied',
    expires: 'expires {when}',
    hideContacts: 'Hide contacts',
    browseContacts: 'Browse my contacts',
  },
  expense: {
    edit: 'Edit expense',
    chooseWhoPaid: 'Choose who paid',
    editingKeepsVersion:
      'Editing keeps the old version. Everyone can see what changed, and it can be restored.',
    splitByItem: 'Split by item',
    scanBillTitle: 'Scan the bill',
    scanBillBody:
      'The total and the name of the place come out filled in. Check them — entering them by hand is always free.',
    scan: 'Scan',
    reading: 'Reading…',
    scanReconciles: 'Read the total off the bill. Check it, then split it however you like.',
    scanCheckTotal: 'Check the total against the bill before saving.',
    descriptionPlaceholder: 'Beach shack dinner',
    howToSplit: 'How to split',
    equally: 'Equally',
    shares: 'Shares',
    percent: 'Percent',
    splitBetween: 'Split between',
    ofCount: '{chosen} of {total}',
    saveChanges: 'Save changes',
    notFound: 'Expense not found',
    notFoundBody: 'It may have been deleted more than 30 days ago.',
    deleteQuestion: 'Delete this expense?',
    deleteBody:
      'It stops counting towards balances but stays in the activity feed, and anyone in the group can restore it for 30 days.',
    deleted: 'deleted',
    whoOwesWhat: 'Who owes what',
    history: 'History',
    restore: 'Restore this expense',
    deleteAction: 'Delete expense',
    splitEqually: 'Split equally',
    exactAmounts: 'Exact amounts',
    byPercentage: 'By percentage',
    byShares: 'By shares',
    withAdjustments: 'With adjustments',
    itemized: 'Itemized',
  },
  misc: {
    newGroupPlaceholder: 'Goa trip',
    personName: "Person's name",
    createGroup: 'Create group',
    linkExpired: 'This link has expired',
    linkExpiredBody:
      'Ask whoever sent it for a fresh one — links expire so they cannot be passed around forever.',
    linkMissingCode: 'This link is missing its invite code',
    goToBaaki: 'Go to Baaki',
    freeNoAccount: 'Free forever, no account needed',
    isOneOfTheseYou: 'Is one of these you?',
    unnamed: 'Unnamed',
    joinAndClaim: 'Join and claim my history',
    joinGroup: 'Join this group',
    fromYourContacts: 'From your contacts',
    continueWith: 'Continue with',
    noAddress: 'No address',
    addToWhichGroup: 'Add to which group?',
    addThemAllToWhichGroup: 'Add them all to which group?',
    startAGroup: 'Start a group',
    pickDifferentPeople: 'Pick different people',
    someone: 'Someone',
    serverRefused: 'The server refused this change.',
    offlineSaved: 'Offline — everything here is saved on this phone',
    notAnAmount: 'That does not look like an amount',
    notARate: 'That does not look like a rate',
    paidAnotherCurrency: 'Paid in another currency',
    whatIWasCharged: 'What I was charged',
    askingRate: 'Asking…',
    getTodaysRate: 'Get today’s {from}→{to} rate',
    micPermission: 'Baaki needs permission to use the microphone.',
    micBlocked: 'Microphone access is off for Baaki. You can turn it on in Settings.',
    dictationFailed: 'Dictation could not start. Type the note instead.',
    stopDictating: 'Stop dictating',
    dictateNote: 'Dictate the note',
    updateBaaki: 'Update Baaki',
    alreadyUpdated: 'I have already updated',
    update: 'Update',
    notNow: 'Not now',
    changeGroupPhoto: 'Change group photo',
    addGroupPhoto: 'Add a group photo',
    changeYourPhoto: 'Change your photo',
    addYourPhoto: 'Add a photo',
    followMyPhone: 'Follow my phone',
    currentlyLanguage: 'Currently {language}',
    rightToLeft: 'right to left',
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
    ok: 'சரி',
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
    languageRestartHintBack: '{language} · தளவமைப்பை மீட்க பாக்கியை மீண்டும் திற',
    restartTitle: 'பாக்கியை மூடித் திறக்கவும்',
    restartBannerMirror:
      'சொற்கள் ஏற்கெனவே மாறிவிட்டன. தளவமைப்பைப் பிரதிபலிப்பது — அம்புக்குறிகள், எல்லாம் அமரும் பக்கம் — செயலி தொடங்கும்போது ஃபோன் முடிவு செய்வது. எனவே அடுத்த முறை திறக்கும்போதுதான் அது நடக்கும்.',
    restartBannerUnmirror:
      'சொற்கள் ஏற்கெனவே மாறிவிட்டன. பிரதிபலித்த தளவமைப்பை மீண்டும் மாற்றுவதும் செயலி தொடங்கும்போது ஃபோன் முடிவு செய்வது. எனவே அடுத்த முறை திறக்கும்போதுதான் அது நடக்கும்.',
    languageFooterNote:
      'உங்கள் ஃபோனின் மொழியே இயல்புநிலை; இங்கே தேர்ந்தெடுப்பது பாக்கியை மட்டுமே மாற்றும். தொகைகளும் தேதிகளும் நீங்கள் இருக்கும் இடத்தையே பின்பற்றும் — துபாயில் இந்தியில் படிப்பது உங்களை இந்தியாவுக்கு நகர்த்தாது.',
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
  notifications: {
    title: 'அறிவிப்புகள்',
    neverSpam:
      'வழக்கமான செலவுச் செயல்பாடுகள் குறித்து பாக்கி உங்களுக்கு மின்னஞ்சல் அனுப்புவதே இல்லை. உங்கள் அஞ்சல் பெட்டியில் நீங்கள் உண்மையிலேயே விரும்பும் ஆறு விஷயங்கள் மட்டுமே, ஒவ்வொன்றையும் தனித்தனியே நிறுத்தலாம்.',
    onThisPhone: 'இந்த ஃபோனில் அறிவிப்புகள்',
    permissionOn:
      'இந்தச் சாதனம் பதிவு செய்யப்பட்டுள்ளது. அறிவிப்பு வந்தாலும் வராவிட்டாலும் கீழே உள்ள அனைத்தும் உங்கள் அஞ்சல் பெட்டியில் வந்து சேரும்.',
    permissionOff:
      'உங்கள் ஃபோன் அவற்றைத் தடுக்கிறது. பாக்கிக்கான சாதன அமைப்புகளில் மீண்டும் இயக்கவும் — எப்படியிருந்தாலும் அஞ்சல் பெட்டியில் எல்லாம் இருக்கும்.',
    permissionUnset:
      'பாக்கி ஒரே ஒரு முறை மட்டுமே கேட்கும், அதுவும் நீங்கள் கீழே இயக்கியவற்றுக்கு மட்டும்.',
    granted: 'இயக்கத்தில்',
    denied: 'நிறுத்தத்தில்',
    undetermined: 'அமைக்கப்படவில்லை',
    asking: 'கேட்கிறது…',
    turnOn: 'அறிவிப்புகளை இயக்கு',
    pushSection: 'அறிவிப்பு',
    involvesMe: 'என்னைச் சார்ந்தவை மட்டும்',
    involvesMeBody:
      'நீங்கள் தர வேண்டியபோதோ, வர வேண்டியபோதோ, குறிப்பிடப்படும்போதோ அறிவிப்பு — ஒவ்வொரு குழுவின் ஒவ்வொரு செலவுக்கும் அல்ல.',
    settlementRequests: 'தீர்வு உறுதிப்படுத்தல்கள்',
    settlementRequestsBody:
      'உங்களுக்குப் பணம் கொடுத்ததாக யாராவது சொல்லும்போது, உங்கள் பாக்கி சரியாக இருக்க.',
    nudges: 'நினைவூட்டல்கள்',
    nudgesBody:
      'தர வேண்டிய பணம் குறித்த மென்மையான நினைவூட்டல். ஒரு நாளைக்கு ஒருவருக்கு ஒன்று மட்டுமே, தரவுத்தளத்திலேயே வரையறுக்கப்பட்டது.',
    digest: 'நாள்தோறும் குழுச் சுருக்கம்',
    digestBody: 'மற்ற அனைத்தும், தொடர்ச்சியாக அல்லாமல் நாளுக்கு ஒரு அறிவிப்பாகத் தொகுத்து.',
    weeklyEmail: 'வாராந்திர மின்னஞ்சல் சுருக்கம்',
    weeklyEmailBody:
      'உங்கள் நிகர பாக்கியும் நிலுவையிலுள்ள உறுதிப்படுத்தல்களும், வாரம் ஒருமுறை. இயல்பாக நிறுத்தத்தில்.',
    failDenied: 'இயக்கப்படவில்லை — பின்னர் ஃபோன் அமைப்புகளில் இயக்கிக்கொள்ளலாம்.',
    failUnsupported:
      'இந்தச் சாதனத்தால் அறிவிப்புகளைப் பெற முடியாது. எல்லாம் செயல்பாட்டுப் பக்கத்தில் வந்து சேரும்.',
    failNotSignedIn: 'முதலில் உள்நுழையவும், எந்த ஃபோன் உங்களுடையது என்று தெரிய.',
    failNotConfigured:
      'பாக்கியின் இந்தப் பதிப்பில் அறிவிப்பு அமைக்கப்படவில்லை. நீங்கள் செய்த தவறு ஒன்றுமில்லை — எல்லாம் செயல்பாட்டுப் பக்கத்தில் வந்து சேரும்.',
    failSaveFailed: 'இந்த ஃபோனைச் சேமிக்க முடியவில்லை. இணைப்பைச் சரிபார்த்து மீண்டும் முயலவும்.',
    footnote:
      'மின்னஞ்சல் இன்னும் வரவில்லை. இங்குள்ள அனைத்தும் உங்கள் அஞ்சல் பெட்டியிலும் இருக்கும் — அறிவிப்பு வந்ததா இல்லையா என்பதைப் பொருட்படுத்தாமல் பாக்கி உங்களிடம் சொன்னதற்கான பதிவு அதுவே.',
  },
  contact: {
    title: 'உங்கள் கணக்கு',
    signedIn: 'உள்நுழைந்துள்ளீர்கள்',
    guestBody:
      'நீங்கள் சேர்த்தவை அனைத்தும் ஏற்கனவே சேமிக்கப்பட்டு உங்களுடையவை. மின்னஞ்சலோ தொலைபேசி எண்ணோ சேர்ப்பது வேறு ஃபோனிலிருந்து இதை அணுகுவதற்காக மட்டுமே.',
    memberBody: 'நீங்கள் உள்நுழையும் எந்தச் சாதனத்திலிருந்தும் இந்தக் கணக்கை அணுகலாம்.',
    email: 'மின்னஞ்சல்',
    phone: 'தொலைபேசி',
    alreadyAdded: 'ஏற்கனவே சேர்க்கப்பட்டது: {value}',
    emailAddress: 'மின்னஞ்சல் முகவரி',
    phoneNumber: 'தொலைபேசி எண்',
    emailPlaceholder: 'you@example.com',
    phonePlaceholder: '+91 98765 43210',
    codeEmailed: 'மின்னஞ்சலில் அனுப்பிய ஆறு இலக்கக் குறியீட்டை உள்ளிடவும்',
    codeTexted: 'குறுஞ்செய்தியில் அனுப்பிய ஆறு இலக்கக் குறியீட்டை உள்ளிடவும்',
    verificationCode: 'சரிபார்ப்புக் குறியீடு',
    confirm: 'உறுதிப்படுத்து',
    sendCodeEmail: 'எனக்கு ஒரு குறியீடு அனுப்பு',
    sendCodePhone: 'குறுஞ்செய்தியில் குறியீடு அனுப்பு',
    useDifferent: 'வேறொன்றைப் பயன்படுத்து',
    added: 'சேர்க்கப்பட்டது. இப்போது வேறு ஃபோனிலும் இதைக் கொண்டு உள்நுழையலாம்.',
    footnote:
      'உள்ளே விடுவதற்கு பாக்கி இதை ஒருபோதும் கேட்பதில்லை, உங்கள் குழுக்களில் உள்ள யாருடனும் இதைப் பகிர்வதும் இல்லை. நீங்கள் தேர்ந்தெடுத்த பெயரை மட்டுமே மற்றவர்கள் பார்ப்பார்கள்.',
  },
  signIn: {
    tagline: 'பாக்கி · மீதம் இருப்பது',
    splitAnything: 'எதையும் பிரி\nயாருடனும்',
    welcomeBody:
      'தொடங்க கணக்கு தேவையில்லை — பின்னர் ஒன்றைச் சேர்த்தால் நீங்கள் சேர்த்த அனைத்தும் உங்களுடன் வரும்.',
    startNow: 'இப்போதே தொடங்கு',
    haveAccount: 'என்னிடம் ஏற்கனவே கணக்கு உள்ளது',
    welcomeBack: 'மீண்டும் வரவேற்கிறோம்',
    keepOnNextPhone: 'அடுத்த ஃபோனிலும் இந்தக் கணக்கை வைத்திருங்கள்',
    guestAddWay:
      'உள்நுழைய ஒரு வழியைச் சேர்க்கவும், அடுத்த ஃபோனிலும் இந்தக் கணக்கு உங்களுடையதாக இருக்கும்.',
    signInHowever: 'நீங்கள் அமைத்த முறையில் உள்நுழையவும்.',
    sendMeACode: 'எனக்கு ஒரு குறியீடு அனுப்பு',
    useAPassword: 'கடவுச்சொல்லைப் பயன்படுத்து',
    phoneNumber: 'தொலைபேசி எண்',
    countryCodeHint:
      'நாட்டுக் குறியீட்டுடன் தொடங்குங்கள். பாக்கி +91 என்று ஊகிப்பதே இல்லை — வெளிநாட்டு எண்கள் வருவது பயணத்தின்போதுதான்.',
    sendCode: 'குறியீடு அனுப்பு',
    codeSentTo: '{value} க்கு குறியீடு அனுப்பப்பட்டது',
    verify: 'சரிபார்',
    differentNumber: 'வேறு எண்ணைப் பயன்படுத்து',
    identifier: 'மின்னஞ்சல் அல்லது தொலைபேசி எண்',
    identifierPlaceholder: 'asha@example.com அல்லது +91…',
    password: 'கடவுச்சொல்',
    passwordHint:
      'எட்டு எழுத்துகள் அல்லது அதற்கு மேல். நினைவில் நிற்கும் சொற்றொடர், நினைவில் நிற்காத புதிரை விட மேல்.',
    addToAccount: 'இதை என் கணக்கில் சேர்',
    createAccount: 'கணக்கை உருவாக்கு',
    signInAction: 'உள்நுழை',
    switchToSignIn: 'என்னிடம் ஏற்கனவே கணக்கு உள்ளது',
    switchToSignUp: 'நான் புதியவர் — கணக்கை உருவாக்கு',
    continueGoogle: 'Google மூலம் தொடர்',
    signInGoogle: 'Google மூலம் உள்நுழை',
    continueGuest: 'விருந்தினராகத் தொடர்',
    guestFootnote:
      'நீங்கள் ஏற்கனவே சேர்த்த அனைத்தும் அப்படியே இருக்கும். இது மீண்டும் உள்நுழைய ஒரு வழியை மட்டுமே சேர்க்கிறது.',
    memberFootnote:
      'உள்நுழைய ஒரு வழியைச் சேர்க்கும் வரை விருந்தினர் கணக்கு அனைத்தையும் இந்தச் சாதனத்திலேயே வைத்திருக்கும். உங்கள் கணக்கு எப்போதும் பணயம் வைக்கப்படுவதில்லை.',
    restartToMirror: 'தளவமைப்பைப் பிரதிபலிக்க பாக்கியை ஒருமுறை மூடித் திறக்கவும்.',
    restartToUnmirror: 'தளவமைப்பை மீண்டும் மாற்ற பாக்கியை ஒருமுறை மூடித் திறக்கவும்.',
  },
  tabs: {
    guestBanner: 'நீங்கள் பாக்கியை விருந்தினராகப் பயன்படுத்துகிறீர்கள்',
    guestBannerBody:
      'எதுவும் விடுபடவில்லை — நீங்கள் சேர்ப்பவை அனைத்தும் சேமிக்கப்பட்டு உங்களுடையவை. வேறு ஃபோனிலிருந்து அணுக விரும்பும்போது மின்னஞ்சலையோ தொலைபேசி எண்ணையோ சேர்க்கவும்.',
    addYourDetails: 'உங்கள் விவரங்களைச் சேர்',
    loadingGroups: 'உங்கள் குழுக்கள் ஏற்றப்படுகின்றன…',
    noGroups: 'இன்னும் குழுக்கள் இல்லை',
    noGroupsBody:
      'ஒரு பயணத்துக்கோ, வீட்டுக்கோ, இருவருக்கோ ஒன்றைத் தொடங்குங்கள். செலவுகளைச் சேர்ப்பது எப்போதும் இலவசம், வரம்பில்லாதது.',
    activityEmptyBody:
      'ஒவ்வொரு செலவும், திருத்தமும், நீக்கமும், தீர்வும் இங்கே வந்து சேரும் — குழுவில் உள்ள அனைவருக்கும்.',
    inbox: 'அஞ்சல் பெட்டி',
    fromContacts: 'தொடர்புகளிலிருந்து',
    allSquare: 'எல்லாம் சரி',
    allSquareBody:
      'உங்களுக்கு யாரும் தர வேண்டியதில்லை, நீங்களும் யாருக்கும் தர வேண்டியதில்லை. நீங்கள் தீர்த்துக்கொள்ளும் நண்பர்கள் இங்கே தோன்றுவார்கள் — தொடங்க உங்கள் தொடர்புகளிலிருந்து யாரையாவது சேருங்கள்.',
    owesYou: 'உங்களுக்குத் தர வேண்டியவர்கள்',
    youOweThem: 'நீங்கள் தர வேண்டியவர்கள்',
    nobodyOwesYou: 'இப்போது உங்களுக்கு யாரும் தர வேண்டியதில்லை.',
    youAreNotBehind: 'நீங்கள் யாருக்கும் பாக்கி வைத்திருக்கவில்லை.',
    inOneGroup: 'ஒரு குழுவில்',
    acrossGroups: { one: '{n} குழுவில்', other: '{n} குழுக்களில்' },
    notJoined: 'சேரவில்லை',
    group: 'குழு',
  },
  inbox: {
    title: 'அஞ்சல் பெட்டி',
    nothingYetBody:
      'நினைவூட்டல்கள், தீர்வு உறுதிப்படுத்தல்கள், பாக்கி உங்களிடம் சொல்லும் மற்ற அனைத்தும் இங்கே சேரும் — அறிவிப்பு உங்கள் ஃபோனுக்கு வராவிட்டாலும் கூட.',
    recent: 'சமீபத்தியவை',
  },
  group: {
    notFound: 'குழு கிடைக்கவில்லை',
    notFoundBody: 'அது காப்பகப்படுத்தப்பட்டிருக்கலாம், அல்லது நீங்கள் இனி உறுப்பினர் இல்லை.',
    notFoundArchived: 'அது காப்பகப்படுத்தப்பட்டிருக்கலாம்.',
    loading: 'ஏற்றப்படுகிறது…',
    settings: 'குழு அமைப்புகள்',
    mismatch: 'இருப்புகளைப் புதுப்பிக்க வேண்டும்',
    mismatchBody:
      'இந்தக் குழுவின் இருப்புகள் குறித்து இந்தச் சாதனமும் சர்வரும் ஒத்துப்போகவில்லை. இழுத்துப் புதுப்பிக்கவும்; தொடர்ந்தால் கீழே உள்ள கணக்கே சரியானது.',
    confirmReceived: 'கிடைத்தது என்று உறுதிப்படுத்து',
    autoConfirms: 'யாரும் பதிலளிக்காவிட்டால் 7 நாட்களில் தானாகவே உறுதியாகும்.',
    hideDeleted: 'நீக்கியவற்றை மறை',
    showDeleted: 'நீக்கியவற்றைக் காட்டு',
    activityEmptyBody: 'இங்கே நடக்கும் அனைத்தும் இந்தப் பட்டியலில் தோன்றும்.',
    photoUpdated: 'புகைப்படம் புதுப்பிக்கப்பட்டது',
    nameOptional: 'பெயர் (விருப்பம்)',
    groupName: 'குழுவின் பெயர்',
    saveName: 'பெயரைச் சேமி',
    removePhoto: 'புகைப்படத்தை நீக்கு',
    simplifyDebts: 'கடன்களை எளிமையாக்கு',
    simplifyDebtsBody:
      'குழுவைத் தீர்க்கும் மிகக் குறைந்த பணப்பரிமாற்றங்களைப் பரிந்துரைக்கும். யார் யாருக்குத் தர வேண்டும் என்ற உண்மையான கணக்கு மாற்றப்படுவதே இல்லை.',
    membersHint: 'ஆட்களைச் சேர், பெயர் மாற்று, UPI ID அமை',
    invitePeople: 'ஆட்களை அழை',
    invitePeopleHint: 'ஒரு இணைப்பைப் பகிருங்கள் — சேர ஆப் நிறுவத் தேவையில்லை',
    bringThingsIn: 'கொண்டுவருதல்',
    importMessages: 'செய்திகளிலிருந்து இறக்குமதி',
    importMessagesHint:
      'வங்கிச் செய்திகளை ஒட்டுங்கள் — இந்த ஃபோனிலேயே படிக்கப்படும், நீங்கள் உறுதிப்படுத்துவீர்கள்',
    importSplitwise: 'Splitwise ஏற்றுமதியை இறக்குமதி செய்',
    importSplitwiseHint: 'பழைய குழுவின் வரலாற்றைக் கொண்டுவா',
    archiveGroup: 'குழுவைக் காப்பகப்படுத்து',
    leaveGroup: 'குழுவிலிருந்து விலகு',
    leaveWhenZero: 'இங்கே உங்கள் இருப்பு பூஜ்ஜியமானதும் விலகலாம்.',
    settleFirst: 'முதலில் தீர்த்துக்கொள்ளுங்கள்',
    settleFirstBody:
      'இந்தக் குழுவில் உங்களுக்கு இன்னும் இருப்பு உள்ளது. இப்போது விலகினால் அது தொங்கிவிடும் — தீர்த்துவிட்டு விலகுங்கள்.',
    leaveQuestion: 'இந்தக் குழுவிலிருந்து விலகவா?',
    leaveBody: 'உங்கள் பழைய செலவுகள் குழு வரலாற்றில் இருக்கும்.',
    leave: 'விலகு',
    archiveQuestion: 'இந்தக் குழுவைக் காப்பகப்படுத்தவா?',
    archiveBody:
      'இது உங்கள் பட்டியலிலிருந்து மறையும், ஆனால் எதுவும் அழிக்கப்படாது, யார் வேண்டுமானாலும் மீண்டும் கொண்டுவரலாம்.',
    archive: 'காப்பகப்படுத்து',
    nobodyOwes: 'இந்தக் குழுவில் யாரும் யாருக்கும் தர வேண்டியதில்லை.',
    recordedNotMoved: 'பதிவு செய்யப்பட்டது, பாக்கி பணத்தை அனுப்பவில்லை',
  },
  people: {
    invite: 'அழை',
    addSomeone: 'ஒருவரைச் சேர்',
    namePlaceholder: 'ராகுல்',
    contactPlaceholder: 'இணைப்பை அனுப்ப விரும்பினால் மின்னஞ்சல் அல்லது தொலைபேசி',
    yetToJoin: { one: '{n} பேர் இன்னும் சேரவில்லை', other: '{n} பேர் இன்னும் சேரவில்லை' },
    sendInviteLink: 'அழைப்பு இணைப்பை அனுப்பு',
    memberNotFound: 'உறுப்பினர் கிடைக்கவில்லை',
    memberNotFoundBody: 'அவர்கள் குழுவிலிருந்து விலகியிருக்கலாம்.',
    admin: 'நிர்வாகி',
    you: 'நீங்கள்',
    memberName: 'உறுப்பினர் பெயர்',
    ghostNote:
      'இவருக்கு உண்மையான இருப்புகள் உள்ளன. அவர்கள் சேரும்போது இந்த வரலாற்றைத் தங்களுடையதாக்கிக் கொள்ளலாம்.',
    upiForGroup: 'இந்தக் குழுவுக்கான UPI ID',
    upiForGroupNote:
      'இங்கே மட்டும் உங்கள் கணக்கின் UPI ID ஐ மேலெழுதும் — ஒரு குழு வேறு கணக்குக்குத் தீர்க்கும்போது பயனுள்ளது.',
    inviteTitle: 'ஆட்களை அழை',
    anyoneWithLink: 'இணைப்பு உள்ள யாரும் சேரலாம்',
    anyoneWithLinkBody:
      'குழுவைப் பார்க்கவும் செலவுகளைச் சேர்க்கவும் அவர்கள் எதையும் நிறுவவோ கணக்கு உருவாக்கவோ தேவையில்லை.',
    inviteLink: 'அழைப்பு இணைப்பு',
    whatsapp: 'WhatsApp',
    shareAnotherWay: 'வேறு வழியில் பகிர்',
    copyLink: 'இணைப்பை நகலெடு',
    createLink: 'அழைப்பு இணைப்பை உருவாக்கு',
    linkCopied: 'இணைப்பு நகலெடுக்கப்பட்டது',
    expires: '{when} க்கு காலாவதி',
    hideContacts: 'தொடர்புகளை மறை',
    browseContacts: 'என் தொடர்புகளைப் பார்',
  },
  expense: {
    edit: 'செலவைத் திருத்து',
    chooseWhoPaid: 'யார் கொடுத்தார்கள் என்று தேர்ந்தெடுக்கவும்',
    editingKeepsVersion:
      'திருத்தினாலும் பழைய பதிப்பு இருக்கும். என்ன மாறியது என்பதை அனைவரும் பார்க்கலாம், மீட்கவும் முடியும்.',
    splitByItem: 'பொருள் வாரியாகப் பிரி',
    scanBillTitle: 'ரசீதை ஸ்கேன் செய்',
    scanBillBody:
      'மொத்தமும் இடத்தின் பெயரும் தானாக நிரப்பப்படும். சரிபாருங்கள் — கையால் உள்ளிடுவது எப்போதும் இலவசம்.',
    scan: 'ஸ்கேன்',
    reading: 'படிக்கிறது…',
    scanReconciles:
      'ரசீதிலிருந்து மொத்தம் படிக்கப்பட்டது. சரிபார்த்து, உங்களுக்கு ஏற்றபடி பிரியுங்கள்.',
    scanCheckTotal: 'சேமிப்பதற்கு முன் ரசீதுடன் மொத்தத்தைச் சரிபாருங்கள்.',
    descriptionPlaceholder: 'கடற்கரை உணவகச் சாப்பாடு',
    howToSplit: 'எப்படிப் பிரிப்பது',
    equally: 'சமமாக',
    shares: 'பங்குகள்',
    percent: 'சதவீதம்',
    splitBetween: 'யாருக்கிடையே',
    ofCount: '{total} இல் {chosen}',
    saveChanges: 'மாற்றங்களைச் சேமி',
    notFound: 'செலவு கிடைக்கவில்லை',
    notFoundBody: '30 நாட்களுக்கு முன்பே அது நீக்கப்பட்டிருக்கலாம்.',
    deleteQuestion: 'இந்தச் செலவை நீக்கவா?',
    deleteBody:
      'இது இருப்புக் கணக்கில் சேராது, ஆனால் செயல்பாட்டுப் பட்டியலில் இருக்கும், 30 நாட்களுக்குள் குழுவில் யார் வேண்டுமானாலும் மீட்கலாம்.',
    deleted: 'நீக்கப்பட்டது',
    whoOwesWhat: 'யார் என்ன தர வேண்டும்',
    history: 'வரலாறு',
    restore: 'இந்தச் செலவை மீட்டெடு',
    deleteAction: 'செலவை நீக்கு',
    splitEqually: 'சமமாகப் பிரி',
    exactAmounts: 'சரியான தொகைகள்',
    byPercentage: 'சதவீதப்படி',
    byShares: 'பங்குகளின்படி',
    withAdjustments: 'சரிசெய்தலுடன்',
    itemized: 'பொருள் வாரியாக',
  },
  misc: {
    newGroupPlaceholder: 'கோவா பயணம்',
    personName: 'நபரின் பெயர்',
    createGroup: 'குழுவை உருவாக்கு',
    linkExpired: 'இந்த இணைப்பு காலாவதியாகிவிட்டது',
    linkExpiredBody:
      'அனுப்பியவரிடம் புதிய ஒன்றைக் கேளுங்கள் — இணைப்புகள் காலாவதியாவதால்தான் அவை என்றென்றும் கைமாறுவதில்லை.',
    linkMissingCode: 'இந்த இணைப்பில் அழைப்புக் குறியீடு இல்லை',
    goToBaaki: 'பாக்கிக்குச் செல்',
    freeNoAccount: 'எப்போதும் இலவசம், கணக்கு தேவையில்லை',
    isOneOfTheseYou: 'இவர்களில் ஒருவர் நீங்களா?',
    unnamed: 'பெயரிடப்படாதவர்',
    joinAndClaim: 'சேர்ந்து என் வரலாற்றை உரிமை கொள்',
    joinGroup: 'இந்தக் குழுவில் சேர்',
    fromYourContacts: 'உங்கள் தொடர்புகளிலிருந்து',
    continueWith: 'இவர்களுடன் தொடர்',
    noAddress: 'முகவரி இல்லை',
    addToWhichGroup: 'எந்தக் குழுவில் சேர்ப்பது?',
    addThemAllToWhichGroup: 'அனைவரையும் எந்தக் குழுவில் சேர்ப்பது?',
    startAGroup: 'ஒரு குழுவைத் தொடங்கு',
    pickDifferentPeople: 'வேறு ஆட்களைத் தேர்ந்தெடு',
    someone: 'யாரோ',
    serverRefused: 'இந்த மாற்றத்தை சர்வர் ஏற்கவில்லை.',
    offlineSaved: 'இணைப்பு இல்லை — இங்குள்ள அனைத்தும் இந்த ஃபோனில் சேமிக்கப்பட்டுள்ளது',
    notAnAmount: 'இது ஒரு தொகை போல் தெரியவில்லை',
    notARate: 'இது ஒரு மாற்று விகிதம் போல் தெரியவில்லை',
    paidAnotherCurrency: 'வேறு நாணயத்தில் கொடுத்தது',
    whatIWasCharged: 'என்னிடம் வசூலிக்கப்பட்டது',
    askingRate: 'கேட்கிறது…',
    getTodaysRate: 'இன்றைய {from}→{to} விகிதத்தைப் பெறு',
    micPermission: 'ஒலிவாங்கியைப் பயன்படுத்த பாக்கிக்கு அனுமதி தேவை.',
    micBlocked: 'பாக்கிக்கு ஒலிவாங்கி அணுகல் நிறுத்தப்பட்டுள்ளது. அமைப்புகளில் இயக்கலாம்.',
    dictationFailed: 'சொல்வதைப் பதிவு செய்ய முடியவில்லை. குறிப்பைத் தட்டச்சு செய்யுங்கள்.',
    stopDictating: 'சொல்வதை நிறுத்து',
    dictateNote: 'குறிப்பைச் சொல்',
    updateBaaki: 'பாக்கியைப் புதுப்பி',
    alreadyUpdated: 'நான் ஏற்கனவே புதுப்பித்துவிட்டேன்',
    update: 'புதுப்பி',
    notNow: 'இப்போது வேண்டாம்',
    changeGroupPhoto: 'குழுப் புகைப்படத்தை மாற்று',
    addGroupPhoto: 'குழுப் புகைப்படத்தைச் சேர்',
    changeYourPhoto: 'உங்கள் புகைப்படத்தை மாற்று',
    addYourPhoto: 'ஒரு புகைப்படத்தைச் சேர்',
    followMyPhone: 'என் ஃபோனைப் பின்பற்று',
    currentlyLanguage: 'தற்போது {language}',
    rightToLeft: 'வலமிருந்து இடம்',
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
    ok: 'ठीक है',
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
    languageRestartHintBack: '{language} · दिशा वापस लाने के लिए बाकी दोबारा खोलें',
    restartTitle: 'बाकी को बंद करके दोबारा खोलें',
    restartBannerMirror:
      'शब्द तो पहले ही बदल गए हैं। लेआउट को पलटना — तीर, और हर चीज़ किस तरफ़ बैठती है — यह फ़ोन ऐप शुरू होते समय तय करता है, इसलिए यह अगली बार खोलने पर लागू होगा।',
    restartBannerUnmirror:
      'शब्द तो पहले ही बदल गए हैं। पलटे हुए लेआउट को वापस सीधा करना भी फ़ोन ऐप शुरू होते समय तय करता है, इसलिए यह अगली बार खोलने पर लागू होगा।',
    languageFooterNote:
      'आपके फ़ोन की भाषा ही डिफ़ॉल्ट है, और यहाँ चुनने से सिर्फ़ बाकी बदलता है। रकम और तारीखें वहीं के हिसाब से चलती रहेंगी जहाँ आप हैं — दुबई में हिंदी में पढ़ने से आप भारत नहीं पहुँच जाते।',
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
  notifications: {
    title: 'सूचनाएँ',
    neverSpam:
      'रोज़मर्रा की खर्च गतिविधि के लिए बाकी कभी ईमेल नहीं करता। सिर्फ़ वे छह चीज़ें जो आप वाकई इनबॉक्स में चाहेंगे, और हर एक अलग से बंद की जा सकती है।',
    onThisPhone: 'इस फ़ोन पर सूचनाएँ',
    permissionOn:
      'यह डिवाइस पंजीकृत है। सूचना पहुँचे या न पहुँचे, नीचे का सब कुछ आपके इनबॉक्स में आता ही है।',
    permissionOff:
      'आपका फ़ोन इन्हें रोक रहा है। बाकी के लिए सिस्टम सेटिंग्स में इन्हें दोबारा चालू करें — इनबॉक्स में सब कुछ वैसे भी रहेगा।',
    permissionUnset:
      'बाकी सिर्फ़ एक बार पूछेगा, और सिर्फ़ उन्हीं चीज़ों के लिए जो आप नीचे चालू करें।',
    granted: 'चालू',
    denied: 'बंद',
    undetermined: 'तय नहीं',
    asking: 'पूछ रहे हैं…',
    turnOn: 'सूचनाएँ चालू करें',
    pushSection: 'पुश',
    involvesMe: 'सिर्फ़ वही जिनसे मेरा वास्ता है',
    involvesMeBody:
      'जब आप पर बाकी हो, आपको मिलना हो, या आपका ज़िक्र हो तब सूचना — हर समूह के हर खर्च पर नहीं।',
    settlementRequests: 'निपटान की पुष्टि',
    settlementRequestsBody: 'जब कोई कहे कि उसने आपको भुगतान किया, ताकि आपकी बाकी सही रहे।',
    nudges: 'याद दिलाना',
    nudgesBody: 'बाकी पैसे की एक विनम्र याद। डेटाबेस में ही सीमित — एक व्यक्ति को दिन में एक बार।',
    digest: 'दैनिक समूह सारांश',
    digestBody: 'बाकी सब कुछ, लगातार की जगह दिन में एक सूचना में इकट्ठा।',
    weeklyEmail: 'साप्ताहिक ईमेल सारांश',
    weeklyEmailBody: 'आपकी कुल बाकी और लंबित पुष्टियाँ, हफ़्ते में एक बार। डिफ़ॉल्ट रूप से बंद।',
    failDenied: 'चालू नहीं हुआ — आप बाद में फ़ोन सेटिंग्स में इसे चालू कर सकते हैं।',
    failUnsupported: 'यह डिवाइस पुश सूचनाएँ नहीं ले सकता। सब कुछ गतिविधि में आता ही रहेगा।',
    failNotSignedIn: 'पहले साइन इन करें, ताकि पता चले कौन सा फ़ोन आपका है।',
    failNotConfigured:
      'बाकी के इस बिल्ड में पुश सेट नहीं है। आपकी कोई गलती नहीं — सब कुछ गतिविधि में आता रहेगा।',
    failSaveFailed: 'यह फ़ोन सेव नहीं हो सका। कनेक्शन जाँचकर दोबारा कोशिश करें।',
    footnote:
      'ईमेल अभी आना बाकी है। यहाँ का सब कुछ आपके इनबॉक्स में भी है, और सूचना पहुँची या नहीं, बाकी ने आपसे क्या कहा उसका रिकॉर्ड वही है।',
  },
  contact: {
    title: 'आपका खाता',
    signedIn: 'साइन इन हैं',
    guestBody:
      'आपने जो कुछ जोड़ा है वह पहले ही सेव है और आपका है। ईमेल या फ़ोन नंबर जोड़ना सिर्फ़ इसलिए है कि आप इसे किसी दूसरे फ़ोन से भी पा सकें।',
    memberBody: 'जिस भी डिवाइस पर साइन इन करें, यह खाता वहाँ मिल जाएगा।',
    email: 'ईमेल',
    phone: 'फ़ोन',
    alreadyAdded: 'पहले से जुड़ा है: {value}',
    emailAddress: 'ईमेल पता',
    phoneNumber: 'फ़ोन नंबर',
    emailPlaceholder: 'you@example.com',
    phonePlaceholder: '+91 98765 43210',
    codeEmailed: 'ईमेल पर भेजा गया छह अंकों का कोड डालें',
    codeTexted: 'मैसेज पर भेजा गया छह अंकों का कोड डालें',
    verificationCode: 'सत्यापन कोड',
    confirm: 'पुष्टि करें',
    sendCodeEmail: 'मुझे कोड भेजें',
    sendCodePhone: 'मैसेज पर कोड भेजें',
    useDifferent: 'कोई दूसरा इस्तेमाल करें',
    added: 'जुड़ गया। अब आप इससे किसी दूसरे फ़ोन पर साइन इन कर सकते हैं।',
    footnote:
      'अंदर आने देने के लिए बाकी यह कभी नहीं माँगता, और आपके समूह में किसी के साथ इसे साझा नहीं करता। लोग सिर्फ़ वही नाम देखते हैं जो आप चुनते हैं।',
  },
  signIn: {
    tagline: 'बाकी · जो बच रहता है',
    splitAnything: 'कुछ भी बाँटें\nकिसी के साथ भी',
    welcomeBody:
      'शुरू करने के लिए खाता ज़रूरी नहीं — बाद में जोड़ लें, आपका जोड़ा हुआ सब कुछ साथ आ जाएगा।',
    startNow: 'अभी शुरू करें',
    haveAccount: 'मेरा खाता पहले से है',
    welcomeBack: 'वापस स्वागत है',
    keepOnNextPhone: 'इस खाते को अगले फ़ोन पर भी रखें',
    guestAddWay: 'साइन इन का कोई तरीका जोड़ें, ताकि अगले फ़ोन पर भी यह खाता आपका ही रहे।',
    signInHowever: 'जैसे सेट किया था वैसे साइन इन करें।',
    sendMeACode: 'मुझे कोड भेजें',
    useAPassword: 'पासवर्ड इस्तेमाल करें',
    phoneNumber: 'फ़ोन नंबर',
    countryCodeHint:
      'देश कोड से शुरू करें। बाकी +91 कभी नहीं मान लेता — विदेशी नंबर सफ़र में ही तो आते हैं।',
    sendCode: 'कोड भेजें',
    codeSentTo: '{value} पर कोड भेजा गया',
    verify: 'सत्यापित करें',
    differentNumber: 'कोई दूसरा नंबर इस्तेमाल करें',
    identifier: 'ईमेल या फ़ोन नंबर',
    identifierPlaceholder: 'asha@example.com या +91…',
    password: 'पासवर्ड',
    passwordHint: 'आठ या ज़्यादा अक्षर। याद रहने वाला वाक्यांश, न याद रहने वाली पहेली से बेहतर है।',
    addToAccount: 'इसे मेरे खाते में जोड़ें',
    createAccount: 'खाता बनाएँ',
    signInAction: 'साइन इन',
    switchToSignIn: 'मेरा खाता पहले से है',
    switchToSignUp: 'मैं नया हूँ — खाता बनाएँ',
    continueGoogle: 'Google से जारी रखें',
    signInGoogle: 'Google से साइन इन करें',
    continueGuest: 'मेहमान के तौर पर जारी रखें',
    guestFootnote:
      'आपने जो जोड़ा है वह जहाँ है वहीं रहेगा। इससे सिर्फ़ दोबारा साइन इन करने का रास्ता जुड़ता है।',
    memberFootnote:
      'जब तक आप साइन इन का कोई तरीका न जोड़ें, मेहमान खाता सब कुछ इसी डिवाइस पर रखता है। आपका हिसाब कभी बंधक नहीं बनाया जाता।',
    restartToMirror: 'लेआउट की दिशा बदलने के लिए बाकी को एक बार बंद करके खोलें।',
    restartToUnmirror: 'लेआउट वापस पलटने के लिए बाकी को एक बार बंद करके खोलें।',
  },
  tabs: {
    guestBanner: 'आप बाकी को मेहमान के तौर पर इस्तेमाल कर रहे हैं',
    guestBannerBody:
      'कुछ छूट नहीं रहा — आप जो भी डालते हैं वह सेव है और आपका है। जब भी किसी दूसरे फ़ोन से पहुँचना हो, ईमेल या फ़ोन नंबर जोड़ लें।',
    addYourDetails: 'अपनी जानकारी जोड़ें',
    loadingGroups: 'आपके समूह आ रहे हैं…',
    noGroups: 'अभी कोई समूह नहीं',
    noGroupsBody:
      'किसी सफ़र, फ़्लैट, या बस आप दोनों के लिए एक शुरू करें। खर्च जोड़ना हमेशा मुफ़्त और असीमित है।',
    activityEmptyBody: 'हर खर्च, बदलाव, हटाना और निपटान यहीं आता है — समूह के हर व्यक्ति के लिए।',
    inbox: 'इनबॉक्स',
    fromContacts: 'संपर्कों से',
    allSquare: 'सब बराबर',
    allSquareBody:
      'न किसी पर आपका बाकी है, न आप पर किसी का। जिनसे आप हिसाब करेंगे वे यहाँ दिखेंगे — शुरू करने के लिए संपर्कों से किसी को जोड़ें।',
    owesYou: 'आपको देने हैं',
    youOweThem: 'आपको देने हैं जिन्हें',
    nobodyOwesYou: 'अभी किसी पर आपका कुछ बाकी नहीं है।',
    youAreNotBehind: 'आप पर किसी का कुछ बाकी नहीं है।',
    inOneGroup: 'एक समूह में',
    acrossGroups: { one: '{n} समूह में', other: '{n} समूहों में' },
    notJoined: 'शामिल नहीं',
    group: 'समूह',
  },
  inbox: {
    title: 'इनबॉक्स',
    nothingYetBody:
      'याद दिलाना, निपटान की पुष्टि और बाकी जो कुछ भी आपसे कहता है, सब यहाँ जमा होता है — भले ही सूचना आपके फ़ोन तक कभी न पहुँची हो।',
    recent: 'हाल के',
  },
  group: {
    notFound: 'समूह नहीं मिला',
    notFoundBody: 'हो सकता है यह संग्रहित कर दिया गया हो, या आप अब सदस्य न हों।',
    notFoundArchived: 'हो सकता है यह संग्रहित कर दिया गया हो।',
    loading: 'आ रहा है…',
    settings: 'समूह सेटिंग्स',
    mismatch: 'बाकी को ताज़ा करना होगा',
    mismatchBody:
      'इस समूह के हिसाब पर यह डिवाइस और सर्वर सहमत नहीं हैं। खींचकर ताज़ा करें; फिर भी बना रहे तो नीचे का हिसाब ही सही है।',
    confirmReceived: 'मिलने की पुष्टि करें',
    autoConfirms: 'कोई जवाब न दे तो 7 दिन में अपने आप पुष्ट हो जाएगा।',
    hideDeleted: 'हटाए हुए छिपाएँ',
    showDeleted: 'हटाए हुए दिखाएँ',
    activityEmptyBody: 'यहाँ जो कुछ होगा वह इसी फ़ीड में दिखेगा।',
    photoUpdated: 'फ़ोटो बदल गई',
    nameOptional: 'नाम (वैकल्पिक)',
    groupName: 'समूह का नाम',
    saveName: 'नाम सेव करें',
    removePhoto: 'फ़ोटो हटाएँ',
    simplifyDebts: 'हिसाब सरल करें',
    simplifyDebtsBody:
      'समूह को निपटाने के सबसे कम भुगतान सुझाता है। किस पर किसका बाकी है, वह असली हिसाब कभी नहीं बदला जाता।',
    membersHint: 'लोग जोड़ें, नाम बदलें, UPI ID सेट करें',
    invitePeople: 'लोगों को बुलाएँ',
    invitePeopleHint: 'एक लिंक साझा करें — जुड़ने के लिए कुछ इंस्टॉल करने की ज़रूरत नहीं',
    bringThingsIn: 'बाहर से लाएँ',
    importMessages: 'मैसेज से आयात',
    importMessagesHint: 'बैंक मैसेज पेस्ट करें — इसी फ़ोन पर पढ़े जाते हैं, पुष्टि आप करते हैं',
    importSplitwise: 'Splitwise निर्यात आयात करें',
    importSplitwiseHint: 'पुराने समूह का इतिहास ले आएँ',
    archiveGroup: 'समूह संग्रहित करें',
    leaveGroup: 'समूह छोड़ें',
    leaveWhenZero: 'यहाँ आपका हिसाब शून्य होते ही आप छोड़ सकते हैं।',
    settleFirst: 'पहले हिसाब चुकाएँ',
    settleFirstBody:
      'इस समूह में अभी आपका हिसाब बाकी है। अभी छोड़ने पर वह अधर में रह जाएगा — पहले चुकाएँ, फिर छोड़ें।',
    leaveQuestion: 'यह समूह छोड़ें?',
    leaveBody: 'आपके पुराने खर्च समूह के इतिहास में बने रहेंगे।',
    leave: 'छोड़ें',
    archiveQuestion: 'यह समूह संग्रहित करें?',
    archiveBody: 'यह आपकी सूची से हट जाएगा पर मिटेगा कुछ नहीं, और कोई भी इसे वापस ला सकता है।',
    archive: 'संग्रहित करें',
    nobodyOwes: 'इस समूह में किसी पर किसी का कुछ बाकी नहीं है।',
    recordedNotMoved: 'दर्ज किया गया, बाकी ने पैसा नहीं भेजा',
  },
  people: {
    invite: 'बुलाएँ',
    addSomeone: 'किसी को जोड़ें',
    namePlaceholder: 'राहुल',
    contactPlaceholder: 'ईमेल या फ़ोन, अगर उन्हें लिंक भेजना हो',
    yetToJoin: { one: '{n} अभी जुड़ना बाकी', other: '{n} अभी जुड़ना बाकी' },
    sendInviteLink: 'निमंत्रण लिंक भेजें',
    memberNotFound: 'सदस्य नहीं मिला',
    memberNotFoundBody: 'हो सकता है उन्होंने समूह छोड़ दिया हो।',
    admin: 'एडमिन',
    you: 'आप',
    memberName: 'सदस्य का नाम',
    ghostNote: 'इस व्यक्ति का असली हिसाब है। जुड़ने पर वे यह इतिहास अपने नाम कर सकते हैं।',
    upiForGroup: 'इस समूह के लिए UPI ID',
    upiForGroupNote:
      'सिर्फ़ यहाँ आपके खाते की UPI ID की जगह लेता है — जब कोई समूह किसी दूसरे खाते में निपटता हो तो काम आता है।',
    inviteTitle: 'लोगों को बुलाएँ',
    anyoneWithLink: 'जिसके पास लिंक हो वह जुड़ सकता है',
    anyoneWithLinkBody:
      'समूह देखने और खर्च जोड़ने के लिए उन्हें कुछ इंस्टॉल करने या खाता बनाने की ज़रूरत नहीं।',
    inviteLink: 'निमंत्रण लिंक',
    whatsapp: 'WhatsApp',
    shareAnotherWay: 'किसी और तरीके से साझा करें',
    copyLink: 'लिंक कॉपी करें',
    createLink: 'निमंत्रण लिंक बनाएँ',
    linkCopied: 'लिंक कॉपी हो गया',
    expires: '{when} को खत्म',
    hideContacts: 'संपर्क छिपाएँ',
    browseContacts: 'मेरे संपर्क देखें',
  },
  expense: {
    edit: 'खर्च बदलें',
    chooseWhoPaid: 'चुनें किसने दिया',
    editingKeepsVersion:
      'बदलने पर पुराना संस्करण बना रहता है। सब देख सकते हैं क्या बदला, और उसे वापस भी लाया जा सकता है।',
    splitByItem: 'चीज़-वार बाँटें',
    scanBillTitle: 'बिल स्कैन करें',
    scanBillBody:
      'कुल रकम और जगह का नाम अपने आप भर जाते हैं। जाँच लें — हाथ से डालना हमेशा मुफ़्त है।',
    scan: 'स्कैन',
    reading: 'पढ़ रहे हैं…',
    scanReconciles: 'बिल से कुल रकम पढ़ ली। जाँच लें, फिर जैसे चाहें बाँटें।',
    scanCheckTotal: 'सेव करने से पहले कुल रकम बिल से मिला लें।',
    descriptionPlaceholder: 'बीच शैक का खाना',
    howToSplit: 'कैसे बाँटें',
    equally: 'बराबर',
    shares: 'हिस्से',
    percent: 'प्रतिशत',
    splitBetween: 'किनके बीच',
    ofCount: '{total} में से {chosen}',
    saveChanges: 'बदलाव सेव करें',
    notFound: 'खर्च नहीं मिला',
    notFoundBody: 'हो सकता है इसे 30 दिन से पहले हटा दिया गया हो।',
    deleteQuestion: 'यह खर्च मिटाएँ?',
    deleteBody:
      'यह हिसाब में गिनना बंद कर देगा पर गतिविधि में बना रहेगा, और समूह का कोई भी 30 दिन तक इसे वापस ला सकता है।',
    deleted: 'हटाया गया',
    whoOwesWhat: 'किस पर क्या बाकी',
    history: 'इतिहास',
    restore: 'यह खर्च वापस लाएँ',
    deleteAction: 'खर्च मिटाएँ',
    splitEqually: 'बराबर बाँटें',
    exactAmounts: 'सटीक रकम',
    byPercentage: 'प्रतिशत से',
    byShares: 'हिस्सों से',
    withAdjustments: 'समायोजन के साथ',
    itemized: 'चीज़-वार',
  },
  misc: {
    newGroupPlaceholder: 'गोवा ट्रिप',
    personName: 'व्यक्ति का नाम',
    createGroup: 'समूह बनाएँ',
    linkExpired: 'यह लिंक खत्म हो चुका है',
    linkExpiredBody:
      'जिसने भेजा था उससे नया माँग लें — लिंक इसीलिए खत्म होते हैं ताकि वे हमेशा घूमते न रहें।',
    linkMissingCode: 'इस लिंक में निमंत्रण कोड नहीं है',
    goToBaaki: 'बाकी पर जाएँ',
    freeNoAccount: 'हमेशा मुफ़्त, खाता ज़रूरी नहीं',
    isOneOfTheseYou: 'क्या इनमें से कोई आप हैं?',
    unnamed: 'बिना नाम',
    joinAndClaim: 'जुड़ें और अपना इतिहास लें',
    joinGroup: 'इस समूह में जुड़ें',
    fromYourContacts: 'आपके संपर्कों से',
    continueWith: 'इनके साथ जारी रखें',
    noAddress: 'कोई पता नहीं',
    addToWhichGroup: 'किस समूह में जोड़ें?',
    addThemAllToWhichGroup: 'इन सबको किस समूह में जोड़ें?',
    startAGroup: 'समूह शुरू करें',
    pickDifferentPeople: 'दूसरे लोग चुनें',
    someone: 'कोई',
    serverRefused: 'सर्वर ने यह बदलाव नहीं माना।',
    offlineSaved: 'ऑफ़लाइन — यहाँ का सब कुछ इसी फ़ोन पर सेव है',
    notAnAmount: 'यह रकम जैसा नहीं लगता',
    notARate: 'यह दर जैसा नहीं लगता',
    paidAnotherCurrency: 'दूसरी मुद्रा में चुकाया',
    whatIWasCharged: 'मुझसे जो लिया गया',
    askingRate: 'पूछ रहे हैं…',
    getTodaysRate: 'आज की {from}→{to} दर लाएँ',
    micPermission: 'माइक्रोफ़ोन इस्तेमाल करने के लिए बाकी को अनुमति चाहिए।',
    micBlocked: 'बाकी के लिए माइक्रोफ़ोन बंद है। आप इसे सेटिंग्स में चालू कर सकते हैं।',
    dictationFailed: 'बोलकर लिखना शुरू नहीं हो सका। नोट टाइप कर लें।',
    stopDictating: 'बोलना बंद करें',
    dictateNote: 'नोट बोलें',
    updateBaaki: 'बाकी अपडेट करें',
    alreadyUpdated: 'मैंने पहले ही अपडेट कर लिया',
    update: 'अपडेट',
    notNow: 'अभी नहीं',
    changeGroupPhoto: 'समूह की फ़ोटो बदलें',
    addGroupPhoto: 'समूह की फ़ोटो जोड़ें',
    changeYourPhoto: 'अपनी फ़ोटो बदलें',
    addYourPhoto: 'फ़ोटो जोड़ें',
    followMyPhone: 'मेरे फ़ोन के अनुसार',
    currentlyLanguage: 'अभी {language}',
    rightToLeft: 'दाएँ से बाएँ',
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
    ok: 'حسنًا',
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
    languageRestartHintBack: '{language} · أعد فتح باقي لإعادة الاتجاه',
    restartTitle: 'أغلق باقي وافتحه من جديد',
    restartBannerMirror:
      'تغيّرت الكلمات بالفعل. أما عكس اتجاه الواجهة — الأسهم والجهة التي يجلس عليها كل شيء — فيقرره الهاتف عند بدء التطبيق، لذا يسري في المرة القادمة التي تفتحه فيها.',
    restartBannerUnmirror:
      'تغيّرت الكلمات بالفعل. أما إعادة الواجهة المعكوسة إلى اتجاهها فيقرره الهاتف عند بدء التطبيق، لذا يسري في المرة القادمة التي تفتحه فيها.',
    languageFooterNote:
      'لغة هاتفك هي الافتراضية، والاختيار هنا يغيّر باقي وحده. تبقى المبالغ والتواريخ تابعة لمكانك — قراءة التطبيق بالهندية في دبي لا تنقلك إلى الهند.',
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
  notifications: {
    title: 'الإشعارات',
    neverSpam:
      'لا يرسل باقي بريدًا عن نشاط المصروفات المعتاد. ستة أشياء فقط قد ترغب فعلًا في وصولها إلى بريدك، ويمكن إيقاف كل منها وحده.',
    onThisPhone: 'الإشعارات على هذا الهاتف',
    permissionOn: 'هذا الجهاز مسجَّل. كل ما في الأسفل يصل إلى صندوقك سواء وصل الإشعار أم لا.',
    permissionOff:
      'هاتفك يحجبها. أعد تفعيلها من إعدادات النظام لباقي — وصندوق الوارد يحتفظ بكل شيء في الحالتين.',
    permissionUnset: 'سيسأل باقي مرة واحدة فقط، وللأشياء التي تفعّلها في الأسفل فقط.',
    granted: 'مفعّلة',
    denied: 'متوقفة',
    undetermined: 'غير محددة',
    asking: 'جارٍ السؤال…',
    turnOn: 'تفعيل الإشعارات',
    pushSection: 'الإشعارات الفورية',
    involvesMe: 'ما يخصّني فقط',
    involvesMeBody: 'إشعار حين يكون عليك أو لك أو حين تُذكر — لا لكل مصروف في كل مجموعة.',
    settlementRequests: 'تأكيدات التسوية',
    settlementRequestsBody: 'حين يقول أحدهم إنه دفع لك، كي يبقى باقيك صحيحًا.',
    nudges: 'التذكيرات',
    nudgesBody: 'تذكير لطيف بالمال المستحق. مرة واحدة لكل شخص يوميًا، بحدٍّ في قاعدة البيانات.',
    digest: 'ملخص المجموعة اليومي',
    digestBody: 'كل ما تبقّى، مجمّعًا في إشعار واحد يوميًا بدل تدفق مستمر.',
    weeklyEmail: 'ملخص أسبوعي بالبريد',
    weeklyEmailBody: 'صافي باقيك والتأكيدات المعلّقة، مرة كل أسبوع. متوقف افتراضيًا.',
    failDenied: 'لم يُفعَّل — يمكنك تفعيله لاحقًا من إعدادات هاتفك.',
    failUnsupported: 'لا يستطيع هذا الجهاز استقبال الإشعارات. كل شيء يصل إلى النشاط رغم ذلك.',
    failNotSignedIn: 'سجّل الدخول أولًا، كي نعرف أي هاتف هو هاتفك.',
    failNotConfigured:
      'الإشعارات غير مهيأة في هذه النسخة من باقي. لا ذنب لك — كل شيء يصل إلى النشاط رغم ذلك.',
    failSaveFailed: 'تعذّر حفظ هذا الهاتف. تحقق من اتصالك وحاول مرة أخرى.',
    footnote:
      'البريد لم يصل بعد. كل ما هنا موجود أيضًا في صندوقك، وهو سجل ما أخبرك به باقي سواء وصل إشعار أم لا.',
  },
  contact: {
    title: 'حسابك',
    signedIn: 'مسجّل الدخول',
    guestBody:
      'كل ما أدخلته محفوظ بالفعل وهو ملكك. إضافة بريد إلكتروني أو رقم هاتف هي فقط كي تصل إليه من هاتف آخر.',
    memberBody: 'يمكن الوصول إلى هذا الحساب من أي جهاز تسجّل الدخول عليه.',
    email: 'بريد إلكتروني',
    phone: 'هاتف',
    alreadyAdded: 'مضاف بالفعل: {value}',
    emailAddress: 'البريد الإلكتروني',
    phoneNumber: 'رقم الهاتف',
    emailPlaceholder: 'you@example.com',
    phonePlaceholder: '+971 50 123 4567',
    codeEmailed: 'أدخل الرمز المكوّن من ستة أرقام الذي أرسلناه إلى بريدك',
    codeTexted: 'أدخل الرمز المكوّن من ستة أرقام الذي أرسلناه برسالة نصية',
    verificationCode: 'رمز التحقق',
    confirm: 'تأكيد',
    sendCodeEmail: 'أرسل لي رمزًا',
    sendCodePhone: 'أرسل الرمز برسالة',
    useDifferent: 'استخدم غيره',
    added: 'تمت الإضافة. يمكنك الآن تسجيل الدخول به على هاتف آخر.',
    footnote:
      'لا يطلب باقي هذا ليسمح لك بالدخول، ولا يشاركه مع أحد في مجموعاتك. يرى الناس الاسم الذي تختاره، لا غير.',
  },
  signIn: {
    tagline: 'باقي · ما يتبقّى',
    splitAnything: 'قسّم أي شيء\nمع أي أحد',
    welcomeBody: 'لا حاجة لحساب للبدء — أضف واحدًا لاحقًا وسيأتي معك كل ما أدخلته.',
    startNow: 'ابدأ الآن',
    haveAccount: 'لديّ حساب بالفعل',
    welcomeBack: 'أهلًا بعودتك',
    keepOnNextPhone: 'احتفظ بهذا الحساب على هاتفك التالي',
    guestAddWay: 'أضف طريقة لتسجيل الدخول، ليبقى هذا الحساب لك على هاتفك التالي.',
    signInHowever: 'سجّل الدخول بالطريقة التي أعددتها.',
    sendMeACode: 'أرسل لي رمزًا',
    useAPassword: 'استخدم كلمة مرور',
    phoneNumber: 'رقم الهاتف',
    countryCodeHint:
      'ابدأ برمز بلدك. لا يفترض باقي أبدًا رمزًا بعينه — فالأرقام الأجنبية تظهر في السفر تحديدًا.',
    sendCode: 'أرسل الرمز',
    codeSentTo: 'أُرسل الرمز إلى {value}',
    verify: 'تحقّق',
    differentNumber: 'استخدم رقمًا آخر',
    identifier: 'البريد الإلكتروني أو رقم الهاتف',
    identifierPlaceholder: 'asha@example.com أو ‎+971…',
    password: 'كلمة المرور',
    passwordHint: 'ثمانية أحرف أو أكثر. عبارة تتذكّرها خير من لغز لن تتذكّره.',
    addToAccount: 'أضف هذا إلى حسابي',
    createAccount: 'إنشاء حساب',
    signInAction: 'تسجيل الدخول',
    switchToSignIn: 'لديّ حساب بالفعل',
    switchToSignUp: 'أنا جديد هنا — أنشئ حسابًا',
    continueGoogle: 'المتابعة عبر Google',
    signInGoogle: 'تسجيل الدخول عبر Google',
    continueGuest: 'المتابعة كضيف',
    guestFootnote: 'كل ما أضفته يبقى كما هو تمامًا. هذا يضيف فقط طريقة للعودة وتسجيل الدخول.',
    memberFootnote:
      'يحتفظ حساب الضيف بكل شيء على هذا الجهاز حتى تضيف طريقة لتسجيل الدخول. دفترك ليس رهينة أبدًا.',
    restartToMirror: 'أغلق باقي وافتحه مرة واحدة لعكس اتجاه الواجهة.',
    restartToUnmirror: 'أغلق باقي وافتحه مرة واحدة لإعادة اتجاه الواجهة.',
  },
  tabs: {
    guestBanner: 'أنت تستخدم باقي كضيف',
    guestBannerBody:
      'لا شيء ناقص — كل ما تدخله محفوظ وهو ملكك. أضف بريدًا إلكترونيًا أو رقم هاتف متى أردت الوصول إليه من هاتف آخر.',
    addYourDetails: 'أضف بياناتك',
    loadingGroups: 'جارٍ تحميل مجموعاتك…',
    noGroups: 'لا مجموعات بعد',
    noGroupsBody:
      'ابدأ واحدة لرحلة أو لشقة أو لكما أنتما. إضافة المصروفات مجانية وبلا حدود، دائمًا.',
    activityEmptyBody: 'كل مصروف وتعديل وحذف وتسوية يصل إلى هنا — لكل من في المجموعة.',
    inbox: 'صندوق الوارد',
    fromContacts: 'من جهات الاتصال',
    allSquare: 'كل شيء متساوٍ',
    allSquareBody:
      'لا أحد يدين لك ولا أنت تدين لأحد. سيظهر هنا من تسوّي معهم — أضف شخصًا من جهات اتصالك للبدء.',
    owesYou: 'لك عندهم',
    youOweThem: 'عليك لهم',
    nobodyOwesYou: 'لا أحد يدين لك بشيء الآن.',
    youAreNotBehind: 'لست متأخرًا مع أحد.',
    inOneGroup: 'في مجموعة واحدة',
    acrossGroups: {
      zero: 'في {n} مجموعة',
      one: 'في مجموعة واحدة',
      two: 'في مجموعتين',
      few: 'في {n} مجموعات',
      many: 'في {n} مجموعة',
      other: 'في {n} مجموعة',
    },
    notJoined: 'لم ينضم',
    group: 'مجموعة',
  },
  inbox: {
    title: 'صندوق الوارد',
    nothingYetBody:
      'التذكيرات وتأكيدات التسوية وكل ما يخبرك به باقي يتجمّع هنا — حتى حين لا يصل الإشعار إلى هاتفك.',
    recent: 'الأحدث',
  },
  group: {
    notFound: 'المجموعة غير موجودة',
    notFoundBody: 'ربما أُرشفت، أو لم تعد عضوًا فيها.',
    notFoundArchived: 'ربما أُرشفت.',
    loading: 'جارٍ التحميل…',
    settings: 'إعدادات المجموعة',
    mismatch: 'الأرصدة بحاجة إلى تحديث',
    mismatchBody:
      'هذا الجهاز والخادم لا يتفقان على أرصدة هذه المجموعة. اسحب للتحديث؛ وإن استمر الأمر فالدفتر بالأسفل هو المرجع.',
    confirmReceived: 'أكّد الاستلام',
    autoConfirms: 'يتأكد تلقائيًا خلال 7 أيام إن لم يردّ أحد.',
    hideDeleted: 'إخفاء المحذوف',
    showDeleted: 'إظهار المحذوف',
    activityEmptyBody: 'كل ما يحدث هنا يظهر في هذا السجل.',
    photoUpdated: 'تم تحديث الصورة',
    nameOptional: 'الاسم (اختياري)',
    groupName: 'اسم المجموعة',
    saveName: 'حفظ الاسم',
    removePhoto: 'إزالة الصورة',
    simplifyDebts: 'تبسيط الديون',
    simplifyDebtsBody:
      'يقترح أقل عدد من الدفعات لتسوية المجموعة. أما دفتر من يدين لمن فلا يُعاد كتابته أبدًا.',
    membersHint: 'أضف أشخاصًا، غيّر الأسماء، اضبط معرّفات الدفع',
    invitePeople: 'ادعُ أشخاصًا',
    invitePeopleHint: 'شارك رابطًا — لا حاجة لتثبيت شيء للانضمام',
    bringThingsIn: 'استيراد',
    importMessages: 'استيراد من الرسائل',
    importMessagesHint: 'ألصق رسائل المصرف — تُقرأ على هذا الهاتف وتؤكدها أنت',
    importSplitwise: 'استيراد ملف Splitwise',
    importSplitwiseHint: 'أحضر سجل مجموعة قديمة',
    archiveGroup: 'أرشفة المجموعة',
    leaveGroup: 'مغادرة المجموعة',
    leaveWhenZero: 'يمكنك المغادرة حين يصبح رصيدك هنا صفرًا.',
    settleFirst: 'سوِّ حسابك أولًا',
    settleFirstBody:
      'ما زال لك رصيد في هذه المجموعة. المغادرة الآن تتركه معلّقًا — سوِّ الحساب ثم غادر.',
    leaveQuestion: 'مغادرة هذه المجموعة؟',
    leaveBody: 'تبقى مصروفاتك السابقة في سجل المجموعة.',
    leave: 'مغادرة',
    archiveQuestion: 'أرشفة هذه المجموعة؟',
    archiveBody: 'تختفي من قائمتك دون حذف أي شيء، ويمكن لأي أحد إعادتها.',
    archive: 'أرشفة',
    nobodyOwes: 'لا أحد يدين لأحد في هذه المجموعة.',
    recordedNotMoved: 'مسجَّل، ولم يحوّل باقي المال',
  },
  people: {
    invite: 'دعوة',
    addSomeone: 'أضف شخصًا',
    namePlaceholder: 'راكيش',
    contactPlaceholder: 'بريد أو هاتف، إن أردت إرسال الرابط إليه',
    yetToJoin: {
      zero: '{n} لم ينضموا بعد',
      one: 'واحد لم ينضم بعد',
      two: 'اثنان لم ينضما بعد',
      few: '{n} لم ينضموا بعد',
      many: '{n} لم ينضموا بعد',
      other: '{n} لم ينضموا بعد',
    },
    sendInviteLink: 'أرسل رابط دعوة',
    memberNotFound: 'العضو غير موجود',
    memberNotFoundBody: 'ربما غادر المجموعة.',
    admin: 'مشرف',
    you: 'أنت',
    memberName: 'اسم العضو',
    ghostNote: 'لهذا الشخص أرصدة حقيقية. حين ينضم يمكنه أن يطالب بهذا السجل.',
    upiForGroup: 'معرّف الدفع لهذه المجموعة',
    upiForGroupNote: 'يتجاوز معرّف حسابك هنا فقط — مفيد حين تُسوّى مجموعة إلى حساب مختلف.',
    inviteTitle: 'ادعُ أشخاصًا',
    anyoneWithLink: 'يستطيع أي شخص لديه الرابط الانضمام',
    anyoneWithLinkBody: 'لا يحتاجون إلى تثبيت شيء أو إنشاء حساب لرؤية المجموعة وإضافة المصروفات.',
    inviteLink: 'رابط الدعوة',
    whatsapp: 'واتساب',
    shareAnotherWay: 'شارك بطريقة أخرى',
    copyLink: 'نسخ الرابط',
    createLink: 'أنشئ رابط دعوة',
    linkCopied: 'تم نسخ الرابط',
    expires: 'ينتهي {when}',
    hideContacts: 'إخفاء جهات الاتصال',
    browseContacts: 'تصفّح جهات اتصالي',
  },
  expense: {
    edit: 'تعديل المصروف',
    chooseWhoPaid: 'اختر من دفع',
    editingKeepsVersion: 'التعديل يحتفظ بالنسخة القديمة. يرى الجميع ما تغيّر، ويمكن استرجاعها.',
    splitByItem: 'التقسيم حسب الصنف',
    scanBillTitle: 'امسح الفاتورة',
    scanBillBody: 'يُملأ المجموع واسم المكان تلقائيًا. تحقّق منهما — والإدخال اليدوي مجاني دائمًا.',
    scan: 'مسح',
    reading: 'جارٍ القراءة…',
    scanReconciles: 'قرأنا المجموع من الفاتورة. تحقّق منه ثم قسّمه كما تشاء.',
    scanCheckTotal: 'قارن المجموع بالفاتورة قبل الحفظ.',
    descriptionPlaceholder: 'عشاء على الشاطئ',
    howToSplit: 'طريقة التقسيم',
    equally: 'بالتساوي',
    shares: 'حصص',
    percent: 'نسبة مئوية',
    splitBetween: 'التقسيم بين',
    ofCount: '{chosen} من {total}',
    saveChanges: 'حفظ التغييرات',
    notFound: 'المصروف غير موجود',
    notFoundBody: 'ربما حُذف قبل أكثر من 30 يومًا.',
    deleteQuestion: 'حذف هذا المصروف؟',
    deleteBody:
      'سيتوقف احتسابه في الأرصدة لكنه يبقى في سجل النشاط، ويمكن لأي عضو استرجاعه خلال 30 يومًا.',
    deleted: 'محذوف',
    whoOwesWhat: 'من عليه ماذا',
    history: 'السجل',
    restore: 'استرجاع هذا المصروف',
    deleteAction: 'حذف المصروف',
    splitEqually: 'تقسيم بالتساوي',
    exactAmounts: 'مبالغ محددة',
    byPercentage: 'بالنسبة المئوية',
    byShares: 'بالحصص',
    withAdjustments: 'مع تعديلات',
    itemized: 'حسب الأصناف',
  },
  misc: {
    newGroupPlaceholder: 'رحلة دبي',
    personName: 'اسم الشخص',
    createGroup: 'إنشاء مجموعة',
    linkExpired: 'انتهت صلاحية هذا الرابط',
    linkExpiredBody: 'اطلب رابطًا جديدًا ممن أرسله — الروابط تنتهي كي لا تتداول إلى الأبد.',
    linkMissingCode: 'هذا الرابط ينقصه رمز الدعوة',
    goToBaaki: 'اذهب إلى باقي',
    freeNoAccount: 'مجاني دائمًا، بلا حاجة إلى حساب',
    isOneOfTheseYou: 'هل أحد هؤلاء أنت؟',
    unnamed: 'بلا اسم',
    joinAndClaim: 'انضم وطالب بسجلي',
    joinGroup: 'انضم إلى هذه المجموعة',
    fromYourContacts: 'من جهات اتصالك',
    continueWith: 'المتابعة مع',
    noAddress: 'لا يوجد عنوان',
    addToWhichGroup: 'إلى أي مجموعة نضيفه؟',
    addThemAllToWhichGroup: 'إلى أي مجموعة نضيفهم جميعًا؟',
    startAGroup: 'ابدأ مجموعة',
    pickDifferentPeople: 'اختر أشخاصًا آخرين',
    someone: 'أحدهم',
    serverRefused: 'رفض الخادم هذا التغيير.',
    offlineSaved: 'دون اتصال — كل ما هنا محفوظ على هذا الهاتف',
    notAnAmount: 'هذا لا يبدو مبلغًا',
    notARate: 'هذا لا يبدو سعر صرف',
    paidAnotherCurrency: 'دُفع بعملة أخرى',
    whatIWasCharged: 'ما خُصم مني',
    askingRate: 'جارٍ السؤال…',
    getTodaysRate: 'اجلب سعر {from}→{to} اليوم',
    micPermission: 'يحتاج باقي إلى إذن لاستخدام الميكروفون.',
    micBlocked: 'الوصول إلى الميكروفون معطّل لباقي. يمكنك تفعيله من الإعدادات.',
    dictationFailed: 'تعذّر بدء الإملاء. اكتب الملاحظة بدلًا من ذلك.',
    stopDictating: 'إيقاف الإملاء',
    dictateNote: 'أملِ الملاحظة',
    updateBaaki: 'حدّث باقي',
    alreadyUpdated: 'لقد حدّثت بالفعل',
    update: 'تحديث',
    notNow: 'ليس الآن',
    changeGroupPhoto: 'تغيير صورة المجموعة',
    addGroupPhoto: 'أضف صورة للمجموعة',
    changeYourPhoto: 'تغيير صورتك',
    addYourPhoto: 'أضف صورة',
    followMyPhone: 'اتبع هاتفي',
    currentlyLanguage: 'حاليًا {language}',
    rightToLeft: 'من اليمين إلى اليسار',
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
