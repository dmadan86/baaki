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

import {
  currencyForCountry,
  dialingCodeForCountry,
  type CategoryId,
  type CurrencyCode,
} from '@baaki/core';

export enum Language {
  En = 'en',
  Ta = 'ta',
  Hi = 'hi',
  Ar = 'ar',
}

/** Every language this app speaks, in the order the picker lists them. */
export const LANGUAGES: readonly Language[] = [Language.En, Language.Ta, Language.Hi, Language.Ar];

/** The languages that read right to left. */
export const RTL_LANGUAGES: readonly Language[] = [Language.Ar];

/**
 * What each language calls itself, and what English calls it.
 *
 * The endonym leads. Somebody looking for their own language is scanning for
 * the shape of their own script, and "Tamil" written in Latin letters is not
 * that shape — it is the name of their language in a language they may not
 * read. The English gloss follows for everyone else.
 */
export const LANGUAGE_NAMES: Readonly<Record<Language, { own: string; english: string }>> = {
  [Language.En]: { own: 'English', english: 'English' },
  [Language.Ta]: { own: 'தமிழ்', english: 'Tamil' },
  [Language.Hi]: { own: 'हिन्दी', english: 'Hindi' },
  [Language.Ar]: { own: 'العربية', english: 'Arabic' },
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
 * The dictation failure messages, threaded into `dictationError` from the caller.
 *
 * `dictationError` lives in `lib/dictation.ts`, deliberately free of React so it
 * can be tested without a device — so it cannot reach `useStrings` itself. The
 * screen that owns the mic passes this in, the same way the other non-hook
 * helpers here receive their strings.
 */
export interface DictationErrorStrings {
  readonly notAllowed: string;
  readonly noSpeech: string;
  readonly audioBusy: string;
  readonly network: string;
  readonly languageNotSupported: string;
  readonly stopped: string;
}

/**
 * The plural rules for the four languages Baaki speaks, written out.
 *
 * `Intl.PluralRules` is not in the Hermes build this app ships on. It is not
 * merely inaccurate there — the constructor throws, so every plural in the app
 * silently fell through to the `other` form and the home screen read "across 1
 * groups". A `catch` that turns a missing API into the wrong word is worse than
 * no plural support at all, because nothing about it looks broken in a test.
 *
 * These are CLDR's rules for the cardinal case, which is all this is used for.
 * A language Baaki does not speak still gets the one/other rule, which is right
 * for most European languages and no worse than the old behaviour anywhere.
 */
function selectRule(locale: string, count: number): Intl.LDMLPluralRule | null {
  const language = locale.toLowerCase().split(/[-_]/)[0];

  if (language === 'ar') {
    const mod100 = count % 100;
    if (count === 0) return 'zero';
    if (count === 1) return 'one';
    if (count === 2) return 'two';
    if (mod100 >= 3 && mod100 <= 10) return 'few';
    if (mod100 >= 11 && mod100 <= 99) return 'many';
    return 'other';
  }

  // Tamil and Hindi both take `one` for exactly one. Hindi also takes it for 0,
  // which English does not — "0 बदलाव है" is right and "0 changes" is too.
  if (language === 'hi') return count === 0 || count === 1 ? 'one' : 'other';
  if (language === 'en' || language === 'ta') return count === 1 ? 'one' : 'other';

  // A language Baaki does not speak. Let Intl answer if it can.
  return null;
}

/**
 * Picks the form and puts the number in it.
 *
 * `{n}` is replaced with the count formatted for the locale, not with
 * `String(count)` — an Egyptian Arabic locale writes ١٢ and a phrase that says
 * "12" beside Arabic words is a phrase in two number systems.
 */
export function plural(locale: string, count: number, forms: PluralForms): string {
  // Our own rules first, Intl only for a language we do not ship. Asking the
  // platform about the four languages we already know the answer for makes the
  // wording depend on which Android build somebody happens to be holding.
  let rule = selectRule(locale, count);
  if (rule === null) {
    try {
      rule = new Intl.PluralRules(locale).select(count);
    } catch {
      rule = count === 1 ? 'one' : 'other';
    }
  }

  let shown = String(count);
  try {
    shown = new Intl.NumberFormat(locale).format(count);
  } catch {
    // A locale Intl will not take is not a reason to render nothing.
  }

  return (forms[rule] ?? forms.other).replaceAll('{n}', shown);
}

export interface UiStrings {
  greeting: string;
  yourBaaki: string;
  /** "across N groups" on the dashboard total. Plural so it never reads
   *  "across 1 groups". */
  acrossGroups: PluralForms;
  youAreOwed: string;
  youOwe: string;
  allSettled: string;
  yourGroups: string;
  /** The "show every category" chip at the head of the group filter strip. */
  filterAll: string;
  newGroup: string;
  activity: string;
  friends: string;
  /** The Friends list sort menu — the header, and its three keys. */
  sort: {
    by: string;
    amount: string;
    date: string;
    name: string;
  };
  /** The "add a person" quick IOU screen, reached from the Friends header. */
  addPerson: {
    title: string;
    subtitle: string;
    nameLabel: string;
    namePlaceholder: string;
    amountLabel: string;
    directionQuestion: string;
    theyOweMe: string;
    iOweThem: string;
    noteLabel: string;
    notePlaceholder: string;
    save: string;
    couldNotRecord: string;
  };
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
  /** Settle button when a rail hands off to a payment app — "Pay via UPI". */
  payViaRail: string;
  /** The settle sheet's headline, either direction. */
  youPayName: string;
  namePaysYou: string;
  /** The muted note under the settle button, either direction. */
  settleConfirmYouPay: string;
  settleConfirmTheyPay: string;
  members: string;
  /** "3 members" under a group. `members` on its own is a heading, not a count. */
  memberCount: PluralForms;
  notJoinedYet: string;
  scansLeft: string;
  simplifyOn: string;
  simplifyOff: string;
  /** The two explainer lines on the who-pays-whom screen. */
  simplifySuggestBody: string;
  simplifyPairwiseBody: string;
  /** "3 payments" badge over the transfer list. */
  simplifyPaymentsCount: PluralForms;
  /** "{from} pays {to}" — a sentence, so it reads right-to-left too. */
  simplifyPaysWhom: string;
  /** The micro line on my own transfer row. */
  simplifyYouPay: string;
  simplifyYouReceive: string;
  freeForever: string;
  nothingYet: string;
  nothingYetBody: string;
  /** A list failed to load — shown in place of the empty state so a network
   *  error never reads as "you have nothing". */
  loadError: string;
  loadErrorBody: string;
  retry: string;
  whatFor: string;
  spending: string;
  byCategory: string;
  byMonth: string;
  /** Caption under the total: `{currency}` is the code. Two moods, one shape. */
  totalIn: string;
  nothingIn: string;
  /** Under the month chart — says the columns are a way in, not just a picture. */
  tapMonthForDays: string;
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
  /** The plan header's "day N" section marker. `{n}` is the current day. */
  dayNumber: string;
  /** Trip carousel card: which day of the trip today is. `{day}`/`{total}`. */
  tripDay: string;
  planned: string;
  spent: string;
  overBudget: string;
  underBudget: string;
  /** Trip budgets. */
  budgets: string;
  overallBudget: string;
  myBudget: string;
  budgetAmount: string;
  shareWithGroup: string;
  budgetPrivate: string;
  saveBudget: string;
  clearBudget: string;
  budgetLeft: string;
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
    /** Generic 'Loading…' — the spoken label a skeleton screen carries. */
    loading: string;
    close: string;
    cancel: string;
    save: string;
    edit: string;
    remove: string;
    delete: string;
    share: string;
    done: string;
    /** Accessibility prefix for a disclosure's info toggle — "About {title}". */
    about: string;
    guest: string;
    name: string;
    yourName: string;
    emailOrPhone: string;
    notFound: string;
    goBack: string;
    ok: string;
    /**
     * A 429 from an edge function, said without a number.
     *
     * The server knows exactly how many seconds are left and sends them in
     * `Retry-After`; these two sentences deliberately do not repeat it. A
     * countdown in a sentence needs plural agreement, and Arabic has six forms
     * where English has two — so a template with `{seconds}` in it is either
     * wrong in Arabic or a plural table for a message nobody should be seeing
     * twice. The client picks between them on the length of the wait.
     */
    tooFastMoment: string;
    tooFastLater: string;
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
  /** Light, dark, or follow the phone. */
  theme: {
    title: string;
    light: string;
    dark: string;
    lightHint: string;
    darkHint: string;
    /** "Currently {scheme}" — the phone's own setting, on the follow-phone row. */
    currently: string;
    /** Settings-row subtitle when following the phone. */
    followingPhone: string;
    footnote: string;
  };
  /** Which networks sync may use, and what the banner says while it waits. */
  sync: {
    title: string;
    wifi: string;
    wifiHint: string;
    cellular: string;
    cellularHint: string;
    both: string;
    bothHint: string;
    footnote: string;
    /** Screen-reader suffix on the chosen network row ("Wi‑Fi, selected"). */
    selected: string;
    /** Banner while holding the queue for Wi‑Fi. */
    waitingWifi: string;
    /** Banner while holding the queue for mobile data. */
    waitingCellular: string;
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
  /** The devices screen and the free-tier two-device cap. */
  devices: {
    title: string;
    intro: string;
    thisDevice: string;
    signedOut: string;
    lastActive: string;
    signOutOthers: string;
    signOutOthersHint: string;
    signedOutOthers: PluralForms;
    onlyThisDevice: string;
    historyNote: string;
    row: string;
    rowHint: string;
    gateTitle: string;
    gateBody: string;
    gateAction: string;
    gateDismiss: string;
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
    sectionProfile: string;
    sectionBaaki: string;
    sectionSettings: string;
    sectionSecurity: string;
    youRowHint: string;
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
    themeRow: string;
    languageFollowingPhone: string;
    languageRestartHint: string;
    languageRestartHintBack: string;
    restartTitle: string;
    restartNow: string;
    restartBannerMirror: string;
    restartNowMirror: string;
    restartNowUnmirror: string;
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
    /** The weekly email is not a push notification, so it gets its own section. */
    emailSection: string;
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
    signInMethodsTitle: string;
    signInMethodsBody: string;
    link: string;
    linked: string;
    footnote: string;
    /** Shown when a guest is sent here by a limit rather than arriving on their own. */
    gateTitle: string;
    gateGroupBody: string;
    gateExpiredBody: string;
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
    /**
     * Only ever read on Android and on iOS builds without the native module —
     * Apple's own button draws and localises its own label, in rather more
     * languages than these four.
     */
    continueApple: string;
    signInApple: string;
    orSignInWith: string;
    continueGuest: string;
    guestFootnote: string;
    memberFootnote: string;
    /** Fallback when a sign-in attempt fails with nothing a person can act on. */
    couldNotSignIn: string;
    restartToMirror: string;
    restartToUnmirror: string;
  };
  /** The three tabs, and the inbox behind the bell. */
  tabs: {
    guestBanner: string;
    guestBannerBody: string;
    guestDaysLeft: string;
    guestReadOnly: string;
    addYourDetails: string;
    loadingGroups: string;
    noGroups: string;
    noGroupsBody: string;
    activityEmptyBody: string;
    quickActions: string;
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
  /** The dashboard hero carousel's action slides — the promo-style cards that
      sit in the swipe deck after the balance (scan a receipt, add a person). */
  dashHero: {
    scanTitle: string;
    scanBody: string;
    scanCta: string;
    inviteTitle: string;
    inviteBody: string;
    inviteCta: string;
  };
  /** Merging same-person guests into one on the Friends screen (irreversible). */
  mergePeople: {
    entry: string;
    title: string;
    subtitle: string;
    empty: string;
    nameLabel: string;
    namePlaceholder: string;
    warningTitle: string;
    warningBody: string;
    cta: string;
    selected: PluralForms;
    merged: string;
    errorTooFew: string;
    errorNotMergeable: string;
    errorNameRequired: string;
    errorGeneric: string;
  };
  /** Group photos are a paid feature; the cover emoji stays free for everyone. */
  groupPhoto: {
    paidHint: string;
  };
  /** The inbox — the record of what Baaki said, whether or not push arrived. */
  inbox: {
    title: string;
    nothingYetBody: string;
    recent: string;
  };
  /** Captures (A34): an expense caught before it has a group, kept in a personal inbox. */
  captures: {
    title: string;
    captureCta: string;
    newTitle: string;
    emptyTitle: string;
    emptyBody: string;
    amount: string;
    description: string;
    descriptionPlaceholder: string;
    category: string;
    date: string;
    receipt: string;
    addReceipt: string;
    reading: string;
    notSynced: string;
    assign: string;
    assignTitle: string;
    assignBody: string;
    noGroups: string;
    delete: string;
    deleteConfirm: string;
    unassigned: string;
    unassignedBody: PluralForms;
    itemizedTitle: string;
    itemCount: PluralForms;
    couldNotRead: string;
    savedOnDevice: string;
    save: string;
  };
  /** Backing up scanned receipts to the user's own cloud drive (Drive/Dropbox/OneDrive). */
  backup: {
    title: string;
    subtitle: string;
    primaryTitle: string;
    primaryBody: string;
    off: string;
    connect: string;
    disconnect: string;
    connected: string;
    notConfigured: string;
    networkTitle: string;
    wifiOnly: string;
    wifiAndData: string;
    pending: PluralForms;
    allBackedUp: string;
    privacyNote: string;
  };
  /** A group: its screen, its settings, and the ways out of it. */
  group: {
    notFound: string;
    notFoundBody: string;
    notFoundArchived: string;
    loading: string;
    settings: string;
    more: string;
    mismatch: string;
    mismatchBody: string;
    confirmReceived: string;
    /** Heading over an incoming settlement claim; `{name}` is the payer. */
    saysTheyPaidYou: string;
    autoConfirms: string;
    hideDeleted: string;
    showDeleted: string;
    activityEmptyBody: string;
    photoUpdated: string;
    nameOptional: string;
    groupName: string;
    saveName: string;
    /** Opens the group cover-emoji picker. */
    chooseIcon: string;
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
    /** The archived-groups screen, its empty state, and the way back. */
    archivedTitle: string;
    archivedEmpty: string;
    archivedEmptyBody: string;
    unarchive: string;
    /** Caption on an archived row — `{date}` is when it was archived. */
    archivedOn: string;
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
    role: string;
    makeAdmin: string;
    removeAdmin: string;
    adminNote: string;
    adminNeedsAccount: string;
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
    usesBadge: string;
    shareMessage: string;
    emailSubject: string;
    mintMistakeNote: string;
    hideContacts: string;
    browseContacts: string;
    /** Short label for the phone-contacts entry point. */
    contacts: string;
    /** Reminding somebody who owes you to settle, gently (ADR-010). */
    remind: string;
    reminded: string;
    remindedToday: string;
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
    /** The scanned-bill card and the receipt hand-off on the group screen. */
    aBill: string;
    splitBillA11y: string;
    receiptClaimedNone: PluralForms;
    receiptClaimedSome: string;
    scanReadItemsCta: PluralForms;
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
    /** Badge on a list row somebody has disputed — a flag alone is silent to
     *  a screen reader and easy to miss. */
    disputed: string;
    /** An expense nobody described, shown when it has no category to fall back on. */
    untitled: string;
    /** "Asha paid" under a row. The name comes first in English and may not elsewhere. */
    paidByName: string;
    /** "edited twice" — the count is edits, so it starts at one. */
    editedTimes: PluralForms;
    /** "In 4 expenses" over the list on a member. */
    inCount: PluralForms;
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
    /** The line under a group's name on the invite landing screen. */
    peopleSplitting: PluralForms;
    /** "3 people" — a bare count of people, used mid-sentence. */
    peopleCount: PluralForms;
    /** Confirmation after adding contacts to a group. `{count}` is a peopleCount. */
    contactsAdded: string;
    /** Error when one or more contacts could not be added. */
    couldNotAdd: string;
    /** Partial add-contacts failure, carrying why the server refused. `{reason}`. */
    couldNotAddSome: string;
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
    /** The mark on a row that is saved here but has not reached the server. */
    notSentYet: string;
    offlineWithCount: PluralForms;
    cantReachServer: PluralForms;
    syncingCount: PluralForms;
    notAnAmount: string;
    notARate: string;
    paidAnotherCurrency: string;
    whatIWasCharged: string;
    askingRate: string;
    getTodaysRate: string;
    micPermission: string;
    micBlocked: string;
    dictationFailed: string;
    /** Every way dictation can end, in words — threaded into `dictationError`. */
    dictationErrors: DictationErrorStrings;
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
    // Settle payment alerts, dispute panel, trip dates, currency-rate note,
    // dictation status, country picker, update footer, campaign popup,
    // insights note, members note, and the CSV currency mismatch.
    withLabel: string;
    settleNoDetailsTitle: string;
    settleNoDetailsBody: string;
    settleRailFallback: string;
    settlePayTitle: string;
    settlePayBody: string;
    settleSendTo: string;
    recordYes: string;
    recordNo: string;
    recordIt: string;
    noReasonGiven: string;
    disputeStands: string;
    neverMind: string;
    whatsWrongWithIt: string;
    somethingsWrong: string;
    tripDatesTitle: string;
    aboutTripDates: string;
    tripDatesBody: string;
    bankRateNote: string;
    listening: string;
    whereSettle: string;
    youHaveVersion: string;
    versionAvailable: string;
    gotIt: string;
    copied: string;
    tapToCopy: string;
    insightsLiveNote: string;
    nameAloneBody: string;
    noUpiYet: string;
    csvCurrencyMismatch: string;
    // CurrencyRate: the rate methods, labels and notes that were literals.
    rateFetchFailedSuffix: string;
    settlesInHint: string;
    howDoYouKnowRate: string;
    todaysRate: string;
    statementAmountLabel: string;
    amountChargedIn: string;
    fxOneEquals: string;
    fxRateFromTo: string;
    convertedApprox: string;
    rateStoredNote: string;
    rateSourceEcb: string;
    rateSourceImplied: string;
    rateSourceYou: string;
    noRateNote: string;
    // DisputePanel.
    thinkThisOff: PluralForms;
    sending: string;
    tellThem: string;
    // The update wall's fallback body and the banner's title.
    versionStoppedBody: string;
    newBaakiOut: string;
    baakiVersionOut: string;
  };
  /** Pasting bank messages in, and what can be made of them (TDR §10). */
  smsImport: {
    title: string;
    howTo: string;
    whyNotAutomatic: string;
    messagesSection: string;
    pasteLabel: string;
    pastePlaceholder: string;
    nothingPasted: string;
    messageCount: PluralForms;
    paste: string;
    datesSection: string;
    datesNote: string;
    from: string;
    to: string;
    last7: string;
    last30: string;
    datePlaceholder: string;
    dateFieldLabel: string;
    foundSection: string;
    nothingToImport: string;
    nothingLikeAPayment: string;
    allAnotherCurrency: string;
    cardPayment: string;
    selected: string;
    notSelected: string;
    checkThis: string;
    otherCurrencyNote: PluralForms;
    whoPaidSection: string;
    whoPaidNote: string;
    addedCount: PluralForms;
    adding: string;
    nothingSelected: string;
    addCount: PluralForms;
    /** Android-only: read the inbox instead of pasting. */
    readMessages: string;
    reading: string;
    readOnAndroid: string;
    readCount: PluralForms;
    readNothing: string;
    permissionDenied: string;
    permissionBlocked: string;
    readUnsupported: string;
    readUnavailable: string;
    readFailed: string;
    /** The Android runtime-permission dialog shown before READ_SMS is granted. */
    permissionRationale: {
      title: string;
      message: string;
      allow: string;
      notNow: string;
    };
    /** Note under a candidate whose date was inferred, not read from the text. */
    dateNotInMessage: string;
  };
  /** Splitting one bill line by line, on one phone or several. */
  itemize: {
    title: string;
    notAMember: string;
    invalidTaxOrTip: string;
    defaultDescription: string;
    sharedNow: string;
    splittingTogether: string;
    splittingTogetherNote: string;
    everyoneHasAPhone: string;
    handOverNote: string;
    sharing: string;
    splitTogether: string;
    whatWasTheBillFor: string;
    descriptionPlaceholder: string;
    descriptionLabel: string;
    addALine: string;
    itemPlaceholder: string;
    itemName: string;
    itemAmount: string;
    unclaimed: string;
    splitWays: PluralForms;
    taxAndTipNote: string;
    taxRow: string;
    tipRow: string;
    taxAmount: string;
    tipAmount: string;
    total: string;
    someone: string;
    waitingForLines: string;
    addTheLines: string;
    stillUnclaimed: PluralForms;
    tapWhoHadEach: string;
    taxAndTipShared: string;
    /** Scanning a bill from the itemize screen, and its editable lines. */
    scanTitle: string;
    scanBody: string;
    scanReadItems: PluralForms;
    scanCheckLines: string;
    carriedOver: string;
    notYours: string;
    itemFallback: string;
    removeItem: string;
    hadItem: string;
  };
  /** Bringing a ledger in from Splitwise or from Baaki's own export. */
  importLedger: {
    splitwiseTitle: string;
    ledgerTitle: string;
    splitwiseHowTo: string;
    bringHistory: string;
    free: string;
    ledgerHowTo: string;
    chooseFile: string;
    chosenFile: string;
    chooseDifferentFile: string;
    whichGroup: string;
    groupNumber: string;
    whoIsWho: string;
    whoIsWhoNote: string;
    tapANameNote: string;
    addAsNew: string;
    newPerson: string;
    importedGroup: string;
    rowsLeftOut: string;
    rowsLeftOutNote: string;
    fileWide: string;
    rowNumber: string;
    whereItGoes: string;
    aNewGroup: string;
    namedAfterFile: string;
    addToThisGroup: string;
    importing: string;
    importCount: PluralForms;
    chooseWhoIs: string;
    chooseWhoArePlural: PluralForms;
    tapYourNameFirst: string;
    imported: string;
    openTheGroup: string;
    importedCount: PluralForms;
    expenseCount: PluralForms;
    settlementCount: PluralForms;
    peopleCount: PluralForms;
    peopleAdded: PluralForms;
    rowsSkipped: PluralForms;
    andMore: string;
    fromBaakiNote: string;
    fromSplitwiseNote: string;
    otherCurrenciesNote: string;
    /** A Baaki export that parsed but held no groups to bring in. */
    noGroupsInFile: string;
    /** Rejects the import when the person marked "me" is not in the target group. */
    couldNotFindYou: string;
  };
  /** Picking people, a country, and the dates a trip runs between. */
  pickers: {
    contactsDenied: string;
    openSettings: string;
    contactsUnavailable: string;
    tryAgain: string;
    searchContacts: string;
    contactCount: PluralForms;
    clearSearch: string;
    nobodyHere: string;
    noContactMatches: string;
    noneHasEmailOrNumber: string;
    onlyPickedAreSent: string;
    jumpToLetter: string;
    country: string;
    /** Title of the phone dialing-code picker sheet. */
    dialCodeTitle: string;
    /** Search field placeholder in the dialing-code picker. */
    searchCountry: string;
    settlesWith: string;
    notSet: string;
    notSetRails: string;
    countryNote: string;
    starts: string;
    ends: string;
    dailyReminders: string;
    breakfast: string;
    endOfDay: string;
    clearDates: string;
    nobodyPickedYet: string;
    personCount: PluralForms;
    alreadyAddedName: string;
    alreadyInGroup: string;
    removeName: string;
    remindZoneNote: string;
    useMyTimezone: string;
  };
  /** Somebody saying an expense is wrong, and the answer to it. */
  dispute: {
    yourReply: string;
    replyPlaceholder: string;
    saving: string;
    theyAreRight: string;
    itIsCorrect: string;
    answerThis: string;
    youSaidWrong: string;
    whatIsWrong: string;
    reasonPlaceholder: string;
    reasonOptional: string;
    fixItMyself: string;
  };
  /** The door where a paid tier would be, and what stays free. */
  upgradeScreen: {
    moreScans: string;
    moreScansBody: string;
    biggerTransfers: string;
    biggerTransfersBody: string;
    nothingToBuy: string;
    nothingToBuyBody: string;
    whatWouldCost: string;
    whatNeverWill: string;
    whatNeverWillBody: string;
  };
  /**
   * Typing in a promotion code.
   *
   * Every refusal gets its own sentence. "That did not work" for a code that
   * has expired, one that is used up and one that was mistyped sends somebody
   * to check the wrong thing three times.
   */
  promo: {
    row: string;
    rowHint: string;
    title: string;
    intro: string;
    placeholder: string;
    redeem: string;
    granted: string;
    grantedBody: string;
    unknownCode: string;
    expired: string;
    exhausted: string;
    alreadyRedeemed: string;
    couldNotRedeem: string;
  };
  /**
   * Taking over a place somebody already holds in a group, and an admin
   * agreeing to it (ADR-006). Worded as a request throughout, because that is
   * what it now is: approving hands over every expense filed under that name.
   */
  claims: {
    askToJoinAs: string;
    needsConfirming: string;
    waitingTitle: string;
    waitingBody: string;
    joinAsNewInstead: string;
    requestsTitle: string;
    saysTheyAre: string;
    approve: string;
    decline: string;
    decideFailed: string;
    alreadyDecided: string;
    placeTaken: string;
    theyAreAlreadyIn: string;
  };
  /** The rest: one or two strings each, from a dozen screens. */
  /**
   * Feedback, the policy screens, and erasure.
   *
   * The policy prose is translated, and the screen says the English text
   * governs — a mistranslated sentence about what happens to somebody's data
   * is worse than an untranslated one, and saying which version is
   * authoritative is the ordinary way to carry that.
   */
  privacy: {
    row: string;
    rowHint: string;
    title: string;
    intro: string;
    storeTitle: string;
    storeBody: string;
    protectTitle: string;
    protectBody: string;
    choicesTitle: string;
    choicesBody: string;
    englishGoverns: string;
    couldNotSave: string;
    analyticsTitle: string;
    analyticsBody: string;
    sessionReplayRow: string;
    previewGroups: PluralForms;
    previewExpenses: PluralForms;
    previewSettlements: PluralForms;
    previewOutstanding: string;
    feedbackRow: string;
    feedbackRowHint: string;
    feedbackTitle: string;
    feedbackHint: string;
    feedbackPlaceholder: string;
    feedbackSend: string;
    feedbackThanks: string;
    kindGeneral: string;
    kindBug: string;
    kindIdea: string;
    deleteRow: string;
    deleteRowHint: string;
    deleteTitle: string;
    deleteIntro: string;
    deleteGoesTitle: string;
    deleteGoesBody: string;
    deleteStaysTitle: string;
    deleteStaysBody: string;
    deleteExportFirst: string;
    deleteWhyLabel: string;
    deleteWhyPlaceholder: string;
    deleteConfirmLabel: string;
    deleteConfirmWord: string;
    deleteButton: string;
    deleteWorking: string;
    deleteDone: string;
    deleteSummary: PluralForms;
  };
  extras: {
    blankNameHint: string;
    whatKindOfGroup: string;
    typeTrip: string;
    typeHome: string;
    typeCouple: string;
    typeEvent: string;
    typeOther: string;
    addPeopleByName: string;
    ghostNote: string;
    claimHistoryNote: string;
    theirPastBecomesYours: string;
    guestKeepsItHere: string;
    lockedTitle: string;
    lockedBody: string;
    unlock: string;
    paidIn: string;
    iKnowTheRate: string;
    notAnAmountShort: string;
    oneChangeFailed: string;
    tryAgain: string;
    discardIt: string;
    needsUpdating: string;
    nothingIsLost: string;
    worthAMinute: string;
    theGroup: string;
    noGroupsYet: string;
    ghostShareNote: string;
    justMe: string;
    /** The footnote under the "just me" month drill-down. */
    yourShareNote: string;
    sms: string;
    email: string;
    paymentWentThrough: string;
    onlyIfCompleted: string;
    restAppliesOverall: string;
    couldNotReadImage: string;
    deliveryComesLater: string;
    perCurrencyNote: string;
    savedStraightAway: string;
    nothingOverwritten: string;
  };
  errorBoundary: {
    title: string;
    body: string;
    action: string;
  };
}

const en: UiStrings = {
  greeting: 'Hello',
  yourBaaki: 'Your baaki',
  acrossGroups: { one: 'across {n} group', other: 'across {n} groups' },
  youAreOwed: 'You are owed',
  youOwe: 'You owe',
  allSettled: 'All settled',
  yourGroups: 'Your groups',
  filterAll: 'All',
  newGroup: 'New group',
  activity: 'Activity',
  friends: 'Friends',
  sort: { by: 'Sort by', amount: 'Amount', date: 'Recent activity', name: 'Name' },
  addPerson: {
    title: 'Add a person',
    subtitle: 'Track what someone owes you — nobody needs the app, and no group to set up.',
    nameLabel: 'Their name',
    namePlaceholder: 'e.g. Ravi',
    amountLabel: 'Amount',
    directionQuestion: 'Which way?',
    theyOweMe: 'They owe me',
    iOweThem: 'I owe them',
    noteLabel: 'Note (optional)',
    notePlaceholder: 'What is it for?',
    save: 'Record it',
    couldNotRecord: 'Could not record this. Please try again.',
  },
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
  payViaRail: 'Pay via {rail}',
  youPayName: 'You pay {name}',
  namePaysYou: '{name} pays you',
  settleConfirmYouPay: '{name} gets asked to confirm. Nothing changes hands through Baaki.',
  settleConfirmTheyPay: 'You will be asked to confirm once they mark it paid.',
  members: 'Members',
  memberCount: { one: '{n} member', other: '{n} members' },
  notJoinedYet: 'not joined yet',
  scansLeft: 'scans left',
  simplifyOn: 'Simplify on',
  simplifyOff: 'Simplify off',
  simplifySuggestBody:
    'Baaki suggests the fewest payments that settle the group. The real who-owes-whom ledger underneath is never rewritten.',
  simplifyPairwiseBody: 'Showing the actual pairwise ledger, exactly as the expenses created it.',
  simplifyPaymentsCount: { one: '{n} payment', other: '{n} payments' },
  simplifyPaysWhom: '{from} pays {to}',
  simplifyYouPay: 'You pay',
  simplifyYouReceive: 'You receive',
  freeForever: 'Unlimited and free, forever',
  nothingYet: 'Nothing here yet',
  nothingYetBody: 'Add your first expense and the maths takes care of itself.',
  loadError: "Couldn't load this",
  loadErrorBody: 'Check your connection and pull to refresh, or try again.',
  retry: 'Try again',
  whatFor: 'What kind of expense',
  spending: 'Spending',
  byCategory: 'Where it went',
  byMonth: 'Month by month',
  totalIn: 'total in {currency}',
  nothingIn: 'nothing in {currency}',
  tapMonthForDays: 'Tap a month to see its days.',
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
  dayNumber: 'day {n}',
  tripDay: 'Day {day} of {total}',
  planned: 'Planned',
  spent: 'Spent',
  overBudget: 'over',
  underBudget: 'under',
  budgets: 'Budgets',
  overallBudget: 'Overall',
  myBudget: 'My budget',
  budgetAmount: 'Amount',
  shareWithGroup: 'Share with group',
  budgetPrivate: 'Only me',
  saveBudget: 'Save',
  clearBudget: 'Clear',
  budgetLeft: 'left',
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
    loading: 'Loading…',
    close: 'Close',
    cancel: 'Cancel',
    save: 'Save',
    edit: 'Edit',
    remove: 'Remove',
    delete: 'Delete',
    share: 'Share',
    done: 'Done',
    about: 'About {title}',
    guest: 'Guest',
    name: 'Name',
    yourName: 'Your name',
    emailOrPhone: 'Email or phone number',
    notFound: 'Not found',
    goBack: 'Go back',
    ok: 'OK',
    tooFastMoment: 'That was a lot at once. Wait a moment and try again.',
    tooFastLater: 'That was a lot at once. Try again in a little while.',
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
  theme: {
    title: 'Appearance',
    light: 'Light',
    dark: 'Dark',
    lightHint: 'The pale lavender canvas.',
    darkHint: 'Easier on the eyes at night.',
    currently: 'Currently {scheme}',
    followingPhone: 'Following your phone',
    footnote: 'Following your phone lets the app turn dark when your phone does.',
  },
  sync: {
    title: 'Sync over',
    wifi: 'Wi‑Fi only',
    wifiHint: 'Sync only on Wi‑Fi. Never spends mobile data.',
    cellular: 'Mobile data only',
    cellularHint: 'Sync only on mobile data, never Wi‑Fi.',
    both: 'Wi‑Fi & mobile data',
    bothHint: 'Sync on whatever connection is up.',
    footnote: 'Changes are always saved on your phone. This only decides when they leave it.',
    selected: 'selected',
    waitingWifi: 'Saved — waiting for Wi‑Fi to sync.',
    waitingCellular: 'Saved — waiting for mobile data to sync.',
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
  devices: {
    title: 'Devices',
    intro:
      'The free plan covers two devices at a time. A device you have not opened in a while stops counting on its own.',
    thisDevice: 'This device',
    signedOut: 'Signed out',
    lastActive: 'Last active {when}',
    signOutOthers: 'Log out all other devices',
    signOutOthersHint: 'Signs out every device except this one. They ask for a login next time.',
    signedOutOthers: {
      one: 'Signed out {n} other device.',
      other: 'Signed out {n} other devices.',
    },
    onlyThisDevice: 'This is the only device signed in.',
    historyNote: 'Showing the last three months.',
    row: 'Devices',
    rowHint: 'See where you are signed in',
    gateTitle: 'Signed in on too many devices',
    gateBody:
      'The free plan covers two devices at a time, and this account is over that. Log out the others to keep using Baaki on this one.',
    gateAction: 'Log out other devices',
    gateDismiss: 'Not now',
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
    sectionProfile: 'Profile',
    sectionBaaki: 'Baaki',
    sectionSettings: 'Settings',
    sectionSecurity: 'Security',
    youRowHint: 'Your name and how you appear',
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
    themeRow: 'Appearance',
    languageFollowingPhone: 'Following your phone — {language}',
    languageRestartHint: '{language} · reopen Baaki to mirror it',
    languageRestartHintBack: '{language} · reopen Baaki to turn the layout back',
    restartTitle: 'Close and open Baaki again',
    restartNow: 'Restart Baaki',
    restartNowMirror: 'Restart Baaki now to mirror the layout?',
    restartNowUnmirror: 'Restart Baaki now to turn the layout back?',
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
    emailSection: 'By email',
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
    phonePlaceholder: '{code} 98765 43210',
    codeEmailed: 'Enter the six-digit code we emailed you',
    codeTexted: 'Enter the six-digit code we texted you',
    verificationCode: 'Verification code',
    confirm: 'Confirm',
    sendCodeEmail: 'Send me a code',
    sendCodePhone: 'Text me a code',
    useDifferent: 'Use a different one',
    added: 'Added. You can sign in with it on another phone now.',
    signInMethodsTitle: 'Ways to sign in',
    signInMethodsBody: 'Link an account and you can sign in with it next time, on any phone.',
    link: 'Link',
    linked: 'Linked',
    footnote:
      'Baaki never asks for this to let you in, and never shares it with anyone in your groups. People see the name you choose, nothing else.',
    gateTitle: 'Keep your account to carry on',
    gateGroupBody:
      "You're in a group as a guest. Add an email, phone or provider to start or join more — everything you've entered stays with you.",
    gateExpiredBody:
      'Your guest trial has ended, so the app is read-only for now. Add a way to sign in to keep adding — your groups and expenses are all still here.',
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
    useAPassword: 'Email or password',
    phoneNumber: 'Phone number',
    countryCodeHint:
      'Start with your country code. Baaki never assumes +91 — a trip is exactly when foreign numbers turn up.',
    sendCode: 'Send code',
    codeSentTo: 'Code sent to {value}',
    verify: 'Verify',
    differentNumber: 'Use a different number',
    identifier: 'Email or phone number',
    identifierPlaceholder: 'alex@example.com or {code}…',
    password: 'Password',
    passwordHint:
      'Eight characters or more. A phrase you will remember beats a puzzle you will not.',
    addToAccount: 'Add this to my account',
    createAccount: 'Create account',
    signInAction: 'Sign in',
    switchToSignIn: 'Already have an account? Sign in',
    switchToSignUp: 'New here? Create an account',
    continueGoogle: 'Continue with Google',
    signInGoogle: 'Sign in with Google',
    continueApple: 'Continue with Apple',
    signInApple: 'Sign in with Apple',
    orSignInWith: 'or sign in with',
    continueGuest: 'Continue as guest',
    guestFootnote:
      'Everything you have already added stays exactly where it is. This only adds a way to sign back in.',
    memberFootnote:
      'A guest account keeps everything on this device until you add a way to sign in. Your ledger is never held hostage.',
    couldNotSignIn: 'Could not sign in. Please try again.',
    restartToMirror: 'Close and open Baaki once to mirror the layout.',
    restartToUnmirror: 'Close and open Baaki once to turn the layout back.',
  },
  tabs: {
    guestBanner: 'You are using Baaki as a guest',
    guestBannerBody:
      'Nothing is missing — everything you enter is saved and yours. Add an email or phone number whenever you want to reach it from another phone.',
    guestDaysLeft: '{days} days left as a guest — sign up to keep going after that.',
    guestReadOnly: 'Your guest trial has ended — the app is read-only. Sign up to keep adding.',
    addYourDetails: 'Add your details',
    loadingGroups: 'Loading your groups…',
    noGroups: 'No groups yet',
    noGroupsBody:
      'Start one for a trip, a flat, or the two of you. Adding expenses is free and unlimited, forever.',
    activityEmptyBody:
      'Every expense, edit, deletion and settlement lands here — for everyone in the group.',
    quickActions: 'Quick actions',
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
  dashHero: {
    scanTitle: 'Snap a receipt',
    scanBody: 'Scan a bill and the items fill themselves in — split it in seconds.',
    scanCta: 'Scan',
    inviteTitle: 'Settle up together',
    inviteBody: 'Add the people you share costs with and keep everyone square.',
    inviteCta: 'Add a person',
  },
  mergePeople: {
    entry: 'Merge people',
    title: 'Merge people',
    subtitle:
      'Pick the guests who are the same person. Their balances are combined under one name.',
    empty: 'No guests to merge — only people without a Baaki account can be merged.',
    nameLabel: 'Name for the merged person',
    namePlaceholder: 'e.g. Ravi',
    warningTitle: 'This can’t be undone',
    warningBody:
      'Their separate balances are combined into one person for good. There’s no way to split them back apart.',
    cta: 'Merge',
    selected: { one: '{n} person selected', other: '{n} people selected' },
    merged: 'Merged into {name}',
    errorTooFew: 'Pick at least two people to merge.',
    errorNotMergeable: 'You can only merge guests you share a group with.',
    errorNameRequired: 'Give the merged person a name.',
    errorGeneric: 'Could not merge. Please try again.',
  },
  groupPhoto: {
    paidHint: 'Group photos are a Plus feature. Pick an icon, or upgrade to add a photo.',
  },
  inbox: {
    title: 'Inbox',
    nothingYetBody:
      'Reminders, settlement confirmations and anything else Baaki tells you collect here — even when the notification never reached your phone.',
    recent: 'Recent',
  },
  captures: {
    title: 'Captures',
    captureCta: 'Capture an expense',
    newTitle: 'Capture an expense',
    emptyTitle: 'Nothing captured yet',
    emptyBody:
      'Catch a spend the moment it happens — the amount, a note, a photo of the bill — and decide which group it belongs to later.',
    amount: 'Amount',
    description: 'What was it?',
    descriptionPlaceholder: 'Coffee, taxi, groceries…',
    category: 'What for?',
    date: 'Date',
    receipt: 'Receipt',
    addReceipt: 'Add receipt',
    reading: 'Reading…',
    notSynced: 'Not synced yet',
    assign: 'Assign to group',
    assignTitle: 'Assign to a group',
    assignBody: 'Pick the group this belongs to. You can set who paid and how it splits next.',
    noGroups: 'You have no groups yet. Make one first, then assign this to it.',
    delete: 'Delete',
    deleteConfirm: 'Delete this capture? The amount and any bill photo go with it.',
    unassigned: 'Unassigned',
    unassignedBody: {
      one: '{n} capture waiting for a group',
      other: '{n} captures waiting for a group',
    },
    itemizedTitle: 'Itemized',
    itemCount: {
      one: '{n} item',
      other: '{n} items',
    },
    couldNotRead: "Couldn't read this bill — enter the amount yourself.",
    savedOnDevice: 'Saved on this device',
    save: 'Save capture',
  },
  backup: {
    title: 'Receipt backup',
    subtitle: 'Keep scanned receipts on your own cloud',
    primaryTitle: 'Back up receipts to',
    primaryBody:
      'Scanned receipts are saved on this device and copied to the drive you choose. They never touch Baaki’s servers.',
    off: 'Off',
    connect: 'Connect',
    disconnect: 'Disconnect',
    connected: 'Connected',
    notConfigured: 'Not set up in this build',
    networkTitle: 'Upload over',
    wifiOnly: 'Wi‑Fi only',
    wifiAndData: 'Wi‑Fi & mobile data',
    pending: {
      one: '{n} receipt waiting to back up',
      other: '{n} receipts waiting to back up',
    },
    allBackedUp: 'All receipts backed up',
    privacyNote:
      'The photo stays on your phone and your chosen cloud. Baaki only ever sees the amount you save.',
  },
  group: {
    notFound: 'Group not found',
    notFoundBody: 'It may have been archived, or you are no longer a member.',
    notFoundArchived: 'It may have been archived.',
    loading: 'Loading…',
    settings: 'Group settings',
    more: 'More',
    mismatch: 'Balances need a refresh',
    mismatchBody:
      'This device and the server disagree about this group’s balances. Pull to refresh; if it persists, the ledger below is the source of truth.',
    confirmReceived: 'Confirm received',
    saysTheyPaidYou: '{name} says they paid you',
    autoConfirms: 'Auto-confirms in 7 days if nobody responds.',
    hideDeleted: 'Hide deleted',
    showDeleted: 'Show deleted',
    activityEmptyBody: 'Everything that happens here shows up in this feed.',
    photoUpdated: 'Photo updated',
    nameOptional: 'Name (optional)',
    groupName: 'Group name',
    saveName: 'Save name',
    chooseIcon: 'Choose an icon',
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
    archivedTitle: 'Archived groups',
    archivedEmpty: 'Nothing archived',
    archivedEmptyBody: 'Groups you archive show up here, ready to bring back.',
    unarchive: 'Unarchive',
    archivedOn: 'Archived {date}',
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
    role: 'Role',
    makeAdmin: 'Make admin',
    removeAdmin: 'Remove admin',
    adminNote: 'Admins can edit the group, manage members, and set the overall budget.',
    adminNeedsAccount: 'They have not joined yet. Only a member with an account can be an admin.',
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
    usesBadge: '{count} uses',
    shareMessage:
      'Join {group} on Baaki to split expenses — no app or account needed to start: {link}',
    emailSubject: 'Join {group} on Baaki',
    mintMistakeNote:
      'Made a link by mistake? Mint a new one — the old link keeps working until it expires, so only share links you mean to.',
    hideContacts: 'Hide contacts',
    browseContacts: 'Browse my contacts',
    contacts: 'Contacts',
    remind: 'Remind',
    reminded: 'Reminded',
    remindedToday: 'Nudged today',
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
    aBill: 'A bill',
    splitBillA11y: 'Split {merchant} by item',
    receiptClaimedNone: {
      one: '{n} line, nobody has claimed it yet. Tap what you had.',
      other: '{n} lines, nobody has claimed one yet. Tap what you had.',
    },
    receiptClaimedSome: '{claimed} of {items} lines claimed. Tap what you had.',
    scanReadItemsCta: {
      one: 'It read {n} item — split by item instead',
      other: 'It read {n} items — split by item instead',
    },
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
    disputed: 'Disputed',
    untitled: 'Untitled',
    paidByName: '{name} paid',
    editedTimes: { one: 'edited once', other: 'edited {n} times' },
    inCount: { one: 'In {n} expense', other: 'In {n} expenses' },
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
    peopleSplitting: {
      one: '{n} person is splitting expenses here',
      other: '{n} people are splitting expenses here',
    },
    peopleCount: { one: '{n} person', other: '{n} people' },
    contactsAdded: '{count} added. Pick somebody else, or go back.',
    couldNotAdd: 'Could not add {names}.',
    couldNotAddSome: 'Could not add everyone. {reason}',
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
    notSentYet: 'Not sent yet',
    offlineWithCount: {
      one: 'Offline — {n} change saved on this phone',
      other: 'Offline — {n} changes saved on this phone',
    },
    cantReachServer: {
      one: "Can't reach the server — {n} change saved here, waiting to send",
      other: "Can't reach the server — {n} changes saved here, waiting to send",
    },
    syncingCount: { one: 'Sending {n} change…', other: 'Sending {n} changes…' },
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
    dictationErrors: {
      notAllowed: 'Baaki needs permission to use the microphone. You can turn it on in Settings.',
      noSpeech: 'Did not catch anything. Tap the mic and speak again.',
      audioBusy: 'The microphone is busy. Close anything else that is recording and try again.',
      network: 'Speech recognition needs a connection on this phone. Type the note instead.',
      languageNotSupported: 'This phone cannot recognise that language yet. Type the note instead.',
      stopped: 'Dictation stopped. Type the note instead.',
    },
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
    withLabel: 'With',
    settleNoDetailsTitle: 'No {rail} details yet',
    settleNoDetailsBody:
      "{name} hasn't added how they're paid. Settle in cash, or ask them to add it.",
    settleRailFallback: 'payment',
    settlePayTitle: 'Pay {name}',
    settlePayBody: '{rail}\n{handle}\n\nThen come back and record it.',
    settleSendTo: 'Send to',
    recordYes: 'Yes, record it',
    recordNo: 'No',
    recordIt: 'Record it',
    noReasonGiven: 'No reason given',
    disputeStands:
      'Nothing has changed yet — your share stands until the expense is corrected. That is deliberate: a share anybody could drop on their own would not be a ledger.',
    neverMind: 'Never mind, it’s fine',
    whatsWrongWithIt: 'What’s wrong with it?',
    somethingsWrong: 'Something’s wrong',
    tripDatesTitle: 'Trip dates',
    aboutTripDates: 'About trip dates',
    tripDatesBody:
      'While the trip is on, everybody gets a nudge to add what they spent — at breakfast about yesterday, and at the end of the day about today. Nobody is asked about a day they have already added to.',
    bankRateNote: 'Your bank’s rate, markup included — this is what your statement says.',
    listening: 'Listening…',
    whereSettle: 'Where does this group settle?',
    youHaveVersion: 'You have {installed}',
    versionAvailable: ' · {latest} is available',
    gotIt: 'Got it',
    copied: 'Copied',
    tapToCopy: 'Tap the button to copy',
    insightsLiveNote:
      'Live expenses only — an edited expense counts at what it now says, and a deleted one does not count at all. Amounts are never converted between currencies.',
    nameAloneBody:
      'A name alone is enough — nobody needs the app, or an email, to be part of the split. An address just means you can send them the link. When they join later they can claim everything already recorded under their name.',
    noUpiYet: 'no UPI ID yet',
    csvCurrencyMismatch:
      'This file is in {fileCur} and this group keeps its money in {groupCur}. Importing it would need a rate for every row, and the file does not carry one — start a {fileCur} group for it instead.',
    rateFetchFailedSuffix: ' — you can type the rate instead',
    settlesInHint: 'This group settles in {currency}',
    howDoYouKnowRate: 'This group settles in {currency}. How do you know the rate?',
    todaysRate: 'Today’s rate',
    statementAmountLabel: 'Amount on your statement, in {currency}',
    amountChargedIn: 'Amount charged in {currency}',
    fxOneEquals: '1 {from} = ? {to}',
    fxRateFromTo: 'Rate from {from} to {to}',
    convertedApprox: '≈ {amount} in {currency}',
    rateStoredNote:
      'Rate {rate} from {source}. Stored with the expense, so this converts the same way later.',
    rateSourceEcb: 'the ECB',
    rateSourceImplied: 'your statement',
    rateSourceYou: 'you',
    noRateNote:
      'Without a rate the expense still saves — it just stays in {currency}, and the group keeps a separate {currency} balance.',
    thinkThisOff: { one: 'Someone thinks this is off', other: '{n} people think this is off' },
    sending: 'Sending…',
    tellThem: 'Tell them',
    versionStoppedBody:
      'This version can no longer talk to Baaki, so it has been stopped rather than left to show you numbers that might be wrong.',
    newBaakiOut: 'A new Baaki is out',
    baakiVersionOut: 'Baaki {latest} is out',
  },
  smsImport: {
    title: 'Import from messages',
    howTo:
      'Open your messages app, select the bank messages from this trip, copy them, and paste them here. Baaki reads them on this phone — nothing is sent anywhere until you confirm an expense.',
    whyNotAutomatic:
      'Baaki cannot read your inbox by itself. iPhones give no app that access, and on Android it is reserved for whichever app you use as your messages app.',
    messagesSection: 'The messages',
    pasteLabel: 'Paste bank messages',
    pastePlaceholder: 'Paste here.\n\nLeave a blank line between messages.',
    nothingPasted: 'Nothing pasted yet',
    messageCount: { one: '{n} message', other: '{n} messages' },
    paste: 'Paste',
    datesSection: 'Between these dates',
    datesNote:
      'Only payments inside this window are proposed, so the rest of your inbox stays out of the group.',
    from: 'From',
    to: 'To',
    last7: 'Last 7 days',
    last30: 'Last 30 days',
    datePlaceholder: 'YYYY-MM-DD',
    dateFieldLabel: '{label} date, year month day',
    foundSection: 'What was found',
    nothingToImport: 'Nothing to import',
    nothingLikeAPayment:
      'None of those messages looked like a payment inside these dates. Reminders, one-time passwords and money coming in are all left out on purpose.',
    allAnotherCurrency: 'Every payment found was in another currency.',
    cardPayment: 'Card payment',
    selected: 'selected',
    notSelected: 'not selected',
    checkThis: 'Check this',
    otherCurrencyNote: {
      one: '{n} payment was in another currency. Add it by hand — the message does not say what rate you were charged, and this group keeps its money in {currency}.',
      other:
        '{n} payments were in another currency. Add them by hand — the message does not say what rate you were charged, and this group keeps its money in {currency}.',
    },
    whoPaidSection: 'Who paid',
    whoPaidNote:
      'A bank message says what left your account, not who was there. These are split equally between everyone in the group — change any of them afterwards.',
    addedCount: {
      one: '{n} expense added. It is saved on this phone and will sync when there is a connection.',
      other:
        '{n} expenses added. They are saved on this phone and will sync when there is a connection.',
    },
    adding: 'Adding…',
    nothingSelected: 'Nothing selected',
    addCount: { one: 'Add {n} expense', other: 'Add {n} expenses' },
    readMessages: 'Read my messages',
    reading: 'Reading…',
    readOnAndroid:
      'On Android, Baaki can read the bank messages in these dates for you. It asks permission first, reads them on this phone, and sends nothing anywhere until you confirm.',
    readCount: {
      one: 'Read {n} message from your inbox.',
      other: 'Read {n} messages from your inbox.',
    },
    readNothing: 'No bank messages found in these dates.',
    permissionDenied:
      'Baaki needs your permission to read messages. You can still paste them below instead.',
    permissionBlocked:
      'Message access is turned off for Baaki. Turn it on in Settings › Apps › Baaki › Permissions, or paste the messages below.',
    readUnsupported: 'Reading messages only works on Android. Paste them below instead.',
    readUnavailable: 'This build cannot read messages. Paste them below instead.',
    readFailed: 'Could not read your messages. Paste them below instead.',
    permissionRationale: {
      title: 'Read bank messages',
      message:
        'Baaki reads bank payment messages on this phone to suggest expenses for your trip. The messages stay on your phone — nothing is sent anywhere until you confirm an expense.',
      allow: 'Allow',
      notNow: 'Not now',
    },
    dateNotInMessage: 'date not in the message',
  },
  itemize: {
    title: 'Split by item',
    notAMember: 'You are not a member of this group',
    invalidTaxOrTip: 'Enter a valid amount for tax and tip.',
    defaultDescription: 'Itemized bill',
    sharedNow: 'Everybody in the group can see this bill now. Tap the lines you had.',
    splittingTogether: 'Splitting together',
    splittingTogetherNote:
      'Everybody in the group is looking at these lines. Tap the ones you had — they see it as you do it. The lines cannot change now, because a claim is pinned to its line.',
    everyoneHasAPhone: 'Everyone at the table has a phone?',
    handOverNote:
      'Hand these lines to the group and they each tap what they had, on their own phone. Check the lines first — once anybody has claimed one, the list is fixed.',
    sharing: 'Sharing…',
    splitTogether: 'Split together',
    whatWasTheBillFor: 'What was the bill for?',
    descriptionPlaceholder: 'Dinner at Anjappar',
    descriptionLabel: 'Bill description',
    addALine: 'Add a line',
    itemPlaceholder: 'Biryani',
    itemName: 'Item name',
    itemAmount: 'Item amount',
    unclaimed: 'nobody has claimed this',
    splitWays: { one: 'to one person', other: 'split {n} ways' },
    taxAndTipNote: 'Tax and tip — prorated by what each person ordered',
    taxRow: 'Tax / service',
    tipRow: 'Tip',
    taxAmount: 'Tax amount',
    tipAmount: 'Tip amount',
    total: 'Total',
    someone: 'Someone',
    waitingForLines: 'Waiting for the lines from this bill.',
    addTheLines: 'Add the lines from the bill and tap who had what.',
    stillUnclaimed: {
      one: '{n} line still unclaimed — nobody pays for a dish nobody ordered.',
      other: '{n} lines still unclaimed — nobody pays for a dish nobody ordered.',
    },
    tapWhoHadEach: 'Tap who had each line to see the split.',
    taxAndTipShared: 'Tax and tip of {amount} are shared in proportion to each person’s items.',
    scanTitle: 'Scan the receipt',
    scanBody:
      'Scan the bill and the items come out filled in. Check them before saving — entering them by hand is always free.',
    scanReadItems: {
      one: 'Read {n} item. Check it, then tap who had what.',
      other: 'Read {n} items. Check them, then tap who had what.',
    },
    scanCheckLines: 'Some lines need checking before this can be saved.',
    carriedOver: 'Carried over from the scan. Check the lines, then tap who had what.',
    notYours: 'They are on Baaki — they tap their own lines.',
    itemFallback: 'Item {n}',
    removeItem: 'Remove {label}',
    hadItem: '{name} had {label}',
  },
  importLedger: {
    splitwiseTitle: 'Import a Splitwise export',
    ledgerTitle: 'Import a ledger',
    splitwiseHowTo:
      'In Splitwise, open the group, choose Export as spreadsheet, and pick the file here.',
    bringHistory: 'Bring your history across',
    free: 'free',
    ledgerHowTo:
      'From Splitwise: open a group → the ⚙ menu → Export as spreadsheet, and choose that CSV here. From Baaki: choose a JSON file you exported from Settings. Everyone named in it becomes a member of the group — they do not need the app, and they can claim their history whenever they join.',
    chooseFile: 'Choose a file',
    chosenFile: 'Chosen: {name}',
    chooseDifferentFile: 'Choose a different file',
    whichGroup: 'Which group',
    groupNumber: 'Group {n}',
    whoIsWho: 'Who is who',
    whoIsWhoNote:
      'The file names people; this group has members. Nothing is imported until every name has somebody against it.',
    tapANameNote:
      'Tap a name to say who they are here. Nobody is matched by name on your behalf — two people really can be called Ravi.',
    addAsNew: 'Add as new',
    newPerson: 'New person',
    importedGroup: 'Imported group',
    rowsLeftOut: 'Rows left out',
    rowsLeftOutNote:
      'Everything else still imports. These are named so you can add them by hand rather than discover later that they are missing.',
    fileWide: 'File',
    rowNumber: 'Row {n}',
    whereItGoes: 'Where it goes',
    aNewGroup: 'A new group',
    namedAfterFile: 'Named after the file',
    addToThisGroup: 'Add to this group',
    importing: 'Importing…',
    importCount: { one: 'Import {n} expense', other: 'Import {n} expenses' },
    chooseWhoIs: 'Choose who {name} is',
    chooseWhoArePlural: { one: 'Choose who {n} person is', other: 'Choose who {n} people are' },
    tapYourNameFirst: 'Tap whichever name is you first — otherwise none of this history is yours.',
    imported: 'Imported',
    openTheGroup: 'Open the group',
    importedCount: {
      one: '{n} expense imported. It is saved on this phone and will sync when there is a connection.',
      other:
        '{n} expenses imported. They are saved on this phone and will sync when there is a connection.',
    },
    expenseCount: { one: '{n} expense', other: '{n} expenses' },
    settlementCount: { one: '{n} settlement', other: '{n} settlements' },
    peopleCount: { one: '{n} person', other: '{n} people' },
    peopleAdded: {
      one: '{n} person added, waiting to be claimed',
      other: '{n} people added, waiting to be claimed',
    },
    rowsSkipped: { one: '{n} row will be skipped', other: '{n} rows will be skipped' },
    andMore: '…and {n} more.',
    fromBaakiNote:
      'Every balance comes across to the paisa, settlements included. What does not come across: the edit history of each expense, and which expenses a past payment was applied against. Neither changes what anybody owes.',
    fromSplitwiseNote:
      'Balances come across exactly. Who paid does not: a Splitwise export records only what each person came out up or down on a row, and many different payers produce the same result. Every imported expense is marked, and you can correct any of them.',
    otherCurrenciesNote:
      'The amounts below are the {currency} ones. {others} come across too, and are never converted.',
    noGroupsInFile: 'That file has no groups to import.',
    couldNotFindYou: 'Could not find you in that group. Open it and try again.',
  },
  pickers: {
    contactsDenied:
      'Baaki cannot see your contacts. You can still add people by typing a name, an email or a number — nothing about a group needs your address book.',
    openSettings: 'Open settings',
    contactsUnavailable:
      'Baaki could not read the address book on this phone. Nothing is wrong with your permissions — add people by typing a name, an email or a number instead.',
    tryAgain: 'Try again',
    searchContacts: 'Search contacts',
    contactCount: { one: '{n} contact', other: '{n} contacts' },
    clearSearch: 'Clear search',
    nobodyHere: 'Nobody here',
    noContactMatches: 'No contact matches that.',
    noneHasEmailOrNumber: 'None of your contacts has an email or number.',
    onlyPickedAreSent:
      'Only the people you pick are sent to Baaki. Your contacts stay on this phone.',
    jumpToLetter: 'Jump to a letter',
    country: 'Country',
    dialCodeTitle: 'Country code',
    searchCountry: 'Search countries',
    settlesWith: '{country} · settles with {rails}',
    notSet: 'Not set',
    notSetRails: 'Bank transfer, cash, Wise and Revolut',
    countryNote:
      'This decides how you can pay each other, and what currency a new expense starts in. Nothing already recorded changes.',
    starts: 'Starts',
    ends: 'Ends',
    dailyReminders: 'Daily reminders',
    breakfast: 'Breakfast',
    endOfDay: 'End of day',
    clearDates: 'Clear dates',
    nobodyPickedYet: 'Nobody picked yet',
    personCount: { one: '{n} person', other: '{n} people' },
    alreadyAddedName: '{name}, already added',
    alreadyInGroup: 'Already in this group',
    removeName: 'Remove {name}',
    remindZoneNote: 'Asked in {zone} — where the trip is, not where each person is.',
    useMyTimezone: 'Use my timezone ({zone})',
  },
  dispute: {
    yourReply: 'Your reply',
    replyPlaceholder: 'Optional — what actually happened',
    saving: 'Saving…',
    theyAreRight: 'They’re right — I’ll fix it',
    itIsCorrect: 'It’s correct',
    answerThis: 'Answer this',
    youSaidWrong: 'You said this is wrong',
    whatIsWrong: 'What is wrong with this expense',
    reasonPlaceholder: 'I left before dessert · the total was ₹1,800',
    reasonOptional:
      'A reason is optional, but it is the difference between a fix and a conversation.',
    fixItMyself: 'Fix it myself',
  },
  upgradeScreen: {
    moreScans: 'More scanned bills',
    moreScansBody:
      'Photograph a receipt and have the lines read off it. Every scan costs real money to run, which is the honest reason it is the thing with a limit.',
    biggerTransfers: 'Bigger exports and imports',
    biggerTransfersBody:
      'Your data is yours and leaves in full for free. Larger jobs and scheduled backups are the convenience.',
    nothingToBuy: 'Nothing to buy yet',
    nothingToBuyBody:
      'This is the door, not the shop. When there is something worth paying for it will be here, with the price on it and no surprises.',
    whatWouldCost: 'What would ever cost money',
    whatNeverWill: 'What never will',
    whatNeverWillBody:
      'The ledger. Groups, expenses, splits, balances, settling up, and getting all of it back out again — {free}. A ledger you can only half read is not a ledger.',
  },
  promo: {
    row: 'Redeem a code',
    rowHint: 'If somebody gave you one',
    title: 'Redeem a code',
    intro: 'Codes are given out by hand — for a support case, a thank-you, or a trial.',
    placeholder: 'BAAKI2026',
    redeem: 'Redeem',
    granted: 'Done',
    grantedBody: 'Plus is on until {until}. Nothing was charged, and nothing renews.',
    unknownCode: 'No code like that. Check the spelling — letters and numbers only.',
    expired: 'That code has passed its date.',
    exhausted: 'That code has been used as many times as it allows.',
    alreadyRedeemed: 'You have already used that one.',
    couldNotRedeem: 'The code could not be checked just now. Try again in a moment.',
  },
  claims: {
    askToJoinAs: 'Ask to join as {name}',
    needsConfirming: 'An admin of the group confirms this before anything moves.',
    waitingTitle: 'Asked',
    waitingBody:
      'Somebody who runs {group} has to confirm you are {name}. You will hear either way — nothing has changed in the group yet.',
    joinAsNewInstead: 'Join as someone new instead',
    requestsTitle: 'Waiting to join',
    saysTheyAre: '{who} says they are {name}',
    approve: 'Confirm',
    decline: 'Not them',
    decideFailed: 'That could not be answered just now. Try again in a moment.',
    alreadyDecided: 'Somebody has already answered this one.',
    placeTaken: 'That place belongs to somebody now.',
    theyAreAlreadyIn: 'They are already in this group.',
  },
  privacy: {
    row: 'Privacy & security',
    rowHint: 'What is stored, and how it is kept',
    title: 'Privacy & security',
    intro:
      'Baaki holds as little about you as it can and still work. This describes what that is, in plain terms.',
    storeTitle: 'What is stored',
    storeBody:
      'Your display name, and whichever of a phone number, email or sign-in identity you used. Optionally a payment handle, so somebody can pay you back, and a country, which decides which payment rails you are offered. The groups you are in, the expenses in them, and who owes whom. Nothing else: no contacts are uploaded, and there is no advertising identifier.',
    protectTitle: 'How it is kept',
    protectBody:
      'Every table is behind row-level security in the database, so a request can only ever read rows your own account is entitled to — not a filter applied by the app, but a rule the database enforces. Receipt images sit in a private bucket reached through short-lived signed links. Crash reports are scrubbed of addresses, phone numbers, payment handles and keys before they leave the phone. You can require your fingerprint or face to open the app.',
    choicesTitle: 'What you can do',
    choicesBody:
      'Export everything you have entered, at any time, in full fidelity and for free. Turn off any notification. Delete your account and the personal data in it. Write to us with anything you want changed.',
    englishGoverns:
      'This text is translated for convenience. Where a translation and the English differ, the English is the one that governs.',
    couldNotSave: 'That did not save. Please try again in a moment.',
    analyticsTitle: 'How the app is used',
    analyticsBody:
      'Baaki can record how screens are used — which ones people get stuck on, where a tap lands — through Microsoft Clarity. It ships switched off and records nothing unless it is turned on. It is never used for advertising, there is no advertising identifier, and nothing here is sold or shared.',
    sessionReplayRow: 'Record how I use the app',
    previewGroups: { one: 'You are in {n} group.', other: 'You are in {n} groups.' },
    previewExpenses: {
      one: 'You entered {n} expense that will stay.',
      other: 'You entered {n} expenses that will stay.',
    },
    previewSettlements: {
      one: 'You are named in {n} settlement.',
      other: 'You are named in {n} settlements.',
    },
    previewOutstanding: 'You still have an unsettled balance in {list}.',
    feedbackRow: 'Send feedback',
    feedbackRowHint: 'Tell us what is wrong, or what is missing',
    feedbackTitle: 'Send feedback',
    feedbackHint:
      'Read by a person, not a queue. Say as much or as little as you like — it helps most when it is specific.',
    feedbackPlaceholder: 'What happened, or what you wish it did',
    feedbackSend: 'Send',
    feedbackThanks: 'Thank you — that has been received.',
    kindGeneral: 'General',
    kindBug: 'Something is broken',
    kindIdea: 'An idea',
    deleteRow: 'Delete my data',
    deleteRowHint: 'Remove your account and personal details',
    deleteTitle: 'Delete my data',
    deleteIntro:
      'This cannot be undone. Please read what it does and does not remove — the second part is the one that surprises people.',
    deleteGoesTitle: 'What is removed',
    deleteGoesBody:
      'Your name, photo, payment handle, country, language and notification settings. Your sign-in, so this account can no longer be opened. Your devices, notification history, purchases and anything the AI scanner recorded about your usage.',
    deleteStaysTitle: 'What stays, and why',
    deleteStaysBody:
      "The expenses and settlements in your shared groups remain, because they are also other people's records — they are what says who owes whom, and removing them would silently change somebody else's balance to settle a debt nobody paid. You become an unnamed former member in those groups. Your name is gone from them; your share of the dinner is not.",
    deleteExportFirst: 'Export your data first',
    deleteWhyLabel: 'Why are you leaving? (optional)',
    deleteWhyPlaceholder: 'It helps to know, and it is kept after your account is gone',
    deleteConfirmLabel: 'Type DELETE to confirm',
    deleteConfirmWord: 'DELETE',
    deleteButton: 'Delete my data',
    deleteWorking: 'Deleting…',
    deleteDone: 'Your data has been deleted.',
    deleteSummary: {
      one: 'You are now a former member of {n} group.',
      other: 'You are now a former member of {n} groups.',
    },
  },
  extras: {
    blankNameHint: 'Leave it blank and the group is named after whoever is in it.',
    whatKindOfGroup: 'What kind of group?',
    typeTrip: 'Trip',
    typeHome: 'Home',
    typeCouple: 'Couple',
    typeEvent: 'Event',
    typeOther: 'Other',
    addPeopleByName: 'Add friends',
    ghostNote: 'They do not need the app. Add them now and they can claim their history later.',
    claimHistoryNote: 'Pick your name and everything already recorded for you comes with you.',
    theirPastBecomesYours: 'Their past expenses and balances become yours.',
    guestKeepsItHere:
      'Joining as a guest keeps everything on this device. Add a phone number later and it all comes with you.',
    lockedTitle: 'Baaki is locked',
    lockedBody: 'Unlock with the same face or fingerprint that opens this phone.',
    unlock: 'Unlock',
    paidIn: 'Paid in',
    iKnowTheRate: 'I know the rate',
    notAnAmountShort: 'not an amount',
    oneChangeFailed: 'One change could not be saved',
    tryAgain: 'Try again',
    discardIt: 'Discard it',
    needsUpdating: 'Baaki needs updating',
    nothingIsLost:
      'Nothing is lost. Every group, expense and settlement is on the server and will be exactly where you left it.',
    worthAMinute: 'Worth a minute when you have one.',
    theGroup: 'The group',
    noGroupsYet:
      'You have no groups yet. A person belongs to a group in Baaki, because a debt is always about something — a trip, a flat, a dinner.',
    ghostShareNote:
      'They do not need the app. Their share is recorded under their name, and if they join later with this email or number they claim everything already sitting there.',
    justMe: 'Just me',
    yourShareNote: 'Just me — each amount is your share, not the whole expense.',
    sms: 'SMS',
    email: 'Email',
    paymentWentThrough: 'Did the payment go through?',
    onlyIfCompleted: 'Only record it if it actually completed.',
    restAppliesOverall: 'The rest applies to the overall balance, oldest expense first.',
    couldNotReadImage: 'Could not read that image.',
    deliveryComesLater:
      'Push and email delivery come with M4. Until then this is where everything lands.',
    perCurrencyNote:
      'Amounts are kept per currency, never converted into one total. People without an account are counted per group, because two people can share a name.',
    savedStraightAway:
      'Saved on this phone straight away, with or without a signal. The server recomputes every share before it is stored, so no device can push a wrong number into the ledger.',
    nothingOverwritten:
      'Nothing here is ever overwritten. Every version above is kept, and a deleted expense can be brought back for 30 days.',
  },
  errorBoundary: {
    title: 'Something went wrong',
    body: 'That screen hit an error. Nothing you saved is lost — go back and try again.',
    action: 'Back to home',
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
  acrossGroups: { one: '{n} குழுவில்', other: '{n} குழுக்களில்' },
  youAreOwed: 'உங்களுக்கு வர வேண்டியது',
  youOwe: 'நீங்கள் தர வேண்டியது',
  allSettled: 'எல்லாம் சரி',
  yourGroups: 'உங்கள் குழுக்கள்',
  filterAll: 'அனைத்தும்',
  newGroup: 'புதிய குழு',
  activity: 'செயல்பாடு',
  friends: 'நண்பர்கள்',
  sort: { by: 'வரிசைப்படுத்து', amount: 'தொகை', date: 'சமீபத்திய செயல்பாடு', name: 'பெயர்' },
  addPerson: {
    title: 'ஒருவரைச் சேர்',
    subtitle:
      'யார் உங்களுக்குத் தர வேண்டும் என்பதைக் கண்காணி — அவருக்கு ஆப் தேவையில்லை, குழுவும் தேவையில்லை.',
    nameLabel: 'அவரது பெயர்',
    namePlaceholder: 'எ.கா. ரவி',
    amountLabel: 'தொகை',
    directionQuestion: 'எந்தப் பக்கம்?',
    theyOweMe: 'அவர் எனக்குத் தர வேண்டும்',
    iOweThem: 'நான் அவருக்குத் தர வேண்டும்',
    noteLabel: 'குறிப்பு (விருப்பம்)',
    notePlaceholder: 'எதற்காக?',
    save: 'பதிவு செய்',
    couldNotRecord: 'இதைப் பதிவு செய்ய முடியவில்லை. மீண்டும் முயற்சிக்கவும்.',
  },
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
  payViaRail: '{rail} மூலம் செலுத்து',
  youPayName: 'நீங்கள் {name}க்குச் செலுத்துகிறீர்கள்',
  namePaysYou: '{name} உங்களுக்குச் செலுத்துகிறார்',
  settleConfirmYouPay: '{name} உறுதிப்படுத்தக் கேட்கப்படுவார். Baaki வழியாக பணம் மாறுவதில்லை.',
  settleConfirmTheyPay:
    'அவர் செலுத்தியதாகக் குறித்ததும் நீங்கள் உறுதிப்படுத்தக் கேட்கப்படுவீர்கள்.',
  members: 'உறுப்பினர்கள்',
  memberCount: { one: '{n} உறுப்பினர்', other: '{n} உறுப்பினர்கள்' },
  notJoinedYet: 'இன்னும் சேரவில்லை',
  scansLeft: 'ஸ்கேன் மீதம்',
  simplifyOn: 'எளிமையாக்கல் இயக்கத்தில்',
  simplifyOff: 'எளிமையாக்கல் நிறுத்தத்தில்',
  simplifySuggestBody:
    'குழுவைத் தீர்க்கும் குறைந்தபட்சப் பரிமாற்றங்களை Baaki பரிந்துரைக்கிறது. அடிப்படையிலுள்ள யார் யாருக்குத் தர வேண்டும் என்ற கணக்கு மாற்றப்படுவதில்லை.',
  simplifyPairwiseBody: 'செலவுகள் உருவாக்கியபடி, உண்மையான இணை-கணக்கைக் காட்டுகிறது.',
  simplifyPaymentsCount: { one: '{n} பரிமாற்றம்', other: '{n} பரிமாற்றங்கள்' },
  simplifyPaysWhom: '{from} {to}க்குச் செலுத்துகிறார்',
  simplifyYouPay: 'நீங்கள் செலுத்துகிறீர்கள்',
  simplifyYouReceive: 'நீங்கள் பெறுகிறீர்கள்',
  freeForever: 'எப்போதும் இலவசம்',
  nothingYet: 'இங்கே இன்னும் ஒன்றுமில்லை',
  nothingYetBody: 'முதல் செலவைச் சேருங்கள் — கணக்கு தானே பார்த்துக்கொள்ளும்.',
  loadError: 'இதை ஏற்ற முடியவில்லை',
  loadErrorBody: 'இணைப்பைச் சரிபார்த்து இழுத்துப் புதுப்பிக்கவும், அல்லது மீண்டும் முயலவும்.',
  retry: 'மீண்டும் முயற்சி',
  whatFor: 'எந்த வகைச் செலவு',
  spending: 'செலவு',
  byCategory: 'எதற்குச் சென்றது',
  byMonth: 'மாதம் வாரியாக',
  totalIn: '{currency} இல் மொத்தம்',
  nothingIn: '{currency} இல் ஏதுமில்லை',
  tapMonthForDays: 'நாட்களைக் காண மாதத்தைத் தட்டவும்.',
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
  dayNumber: 'நாள் {n}',
  tripDay: 'நாள் {day}/{total}',
  planned: 'திட்டமிட்டது',
  spent: 'செலவானது',
  overBudget: 'அதிகம்',
  underBudget: 'குறைவு',
  budgets: 'பட்ஜெட்',
  overallBudget: 'மொத்தம்',
  myBudget: 'என் பட்ஜெட்',
  budgetAmount: 'தொகை',
  shareWithGroup: 'குழுவுடன் பகிர்',
  budgetPrivate: 'எனக்கு மட்டும்',
  saveBudget: 'சேமி',
  clearBudget: 'அழி',
  budgetLeft: 'மீதம்',
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
    loading: 'ஏற்றுகிறது…',
    close: 'மூடு',
    cancel: 'ரத்து',
    save: 'சேமி',
    edit: 'திருத்து',
    remove: 'நீக்கு',
    delete: 'அழி',
    share: 'பகிர்',
    done: 'முடிந்தது',
    about: '{title} பற்றி',
    guest: 'விருந்தினர்',
    name: 'பெயர்',
    yourName: 'உங்கள் பெயர்',
    emailOrPhone: 'மின்னஞ்சல் அல்லது தொலைபேசி எண்',
    notFound: 'கிடைக்கவில்லை',
    goBack: 'திரும்பிச் செல்',
    ok: 'சரி',
    tooFastMoment: 'ஒரே நேரத்தில் அதிகம். சிறிது நேரம் கழித்து மீண்டும் முயற்சிக்கவும்.',
    tooFastLater: 'ஒரே நேரத்தில் அதிகம். சிறிது நேரம் கழித்து மீண்டும் முயலவும்.',
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
  theme: {
    title: 'தோற்றம்',
    light: 'வெளிச்சம்',
    dark: 'இருள்',
    lightHint: 'வெளிர் லாவெண்டர் திரை.',
    darkHint: 'இரவில் கண்களுக்கு எளிது.',
    currently: 'தற்போது {scheme}',
    followingPhone: 'உங்கள் ஃபோனைப் பின்பற்றுகிறது',
    footnote: 'உங்கள் ஃபோனைப் பின்பற்றினால், ஃபோன் இருளும்போது ஆப்பும் இருளும்.',
  },
  sync: {
    title: 'எதன் மூலம் ஒத்திசைவு',
    wifi: 'வைஃபை மட்டும்',
    wifiHint: 'வைஃபையில் மட்டும் ஒத்திசைக்கும். மொபைல் டேட்டா செலவாகாது.',
    cellular: 'மொபைல் டேட்டா மட்டும்',
    cellularHint: 'மொபைல் டேட்டாவில் மட்டும் ஒத்திசைக்கும், வைஃபையில் இல்லை.',
    both: 'வைஃபை & மொபைல் டேட்டா',
    bothHint: 'இணைப்பு எதுவாக இருந்தாலும் ஒத்திசைக்கும்.',
    footnote:
      'மாற்றங்கள் எப்போதும் உங்கள் ஃபோனில் சேமிக்கப்படும். எப்போது வெளியேறும் என்பதை மட்டுமே இது தீர்மானிக்கிறது.',
    selected: 'தேர்ந்தெடுக்கப்பட்டது',
    waitingWifi: 'சேமிக்கப்பட்டது — ஒத்திசைக்க வைஃபைக்காகக் காத்திருக்கிறது.',
    waitingCellular: 'சேமிக்கப்பட்டது — ஒத்திசைக்க மொபைல் டேட்டாவுக்காகக் காத்திருக்கிறது.',
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
  devices: {
    title: 'சாதனங்கள்',
    intro:
      'இலவசத் திட்டத்தில் ஒரே நேரத்தில் இரண்டு சாதனங்கள். சிறிது காலம் திறக்காத சாதனம் தானாகவே கணக்கில் இருந்து விலகும்.',
    thisDevice: 'இந்தச் சாதனம்',
    signedOut: 'வெளியேற்றப்பட்டது',
    lastActive: 'கடைசியாகச் செயலில் {when}',
    signOutOthers: 'மற்ற எல்லா சாதனங்களிலும் வெளியேறு',
    signOutOthersHint:
      'இந்தச் சாதனம் தவிர மற்ற அனைத்திலும் வெளியேற்றும். அடுத்த முறை உள்நுழைவு கேட்கப்படும்.',
    signedOutOthers: {
      one: '{n} சாதனத்தில் வெளியேற்றப்பட்டது.',
      other: '{n} சாதனங்களில் வெளியேற்றப்பட்டது.',
    },
    onlyThisDevice: 'இந்தச் சாதனம் மட்டுமே உள்நுழைந்துள்ளது.',
    historyNote: 'கடந்த மூன்று மாதங்கள் காட்டப்படுகின்றன.',
    row: 'சாதனங்கள்',
    rowHint: 'எங்கு உள்நுழைந்துள்ளீர்கள் என்பதைப் பார்க்கவும்',
    gateTitle: 'மிக அதிக சாதனங்களில் உள்நுழைந்துள்ளது',
    gateBody:
      'இலவசத் திட்டத்தில் ஒரே நேரத்தில் இரண்டு சாதனங்கள் மட்டுமே; இந்தக் கணக்கு அதைத் தாண்டியுள்ளது. இந்தச் சாதனத்தில் பாக்கியைத் தொடர மற்றவற்றில் வெளியேறவும்.',
    gateAction: 'மற்ற சாதனங்களில் வெளியேறு',
    gateDismiss: 'இப்போது வேண்டாம்',
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
    sectionProfile: 'சுயவிவரம்',
    sectionBaaki: 'பாக்கி',
    sectionSettings: 'அமைப்புகள்',
    sectionSecurity: 'பாதுகாப்பு',
    youRowHint: 'உங்கள் பெயரும் நீங்கள் எப்படித் தோன்றுகிறீர்கள் என்பதும்',
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
    themeRow: 'தோற்றம்',
    languageFollowingPhone: 'உங்கள் ஃபோனைப் பின்பற்றுகிறது — {language}',
    languageRestartHint: '{language} · பிரதிபலிக்க பாக்கியை மீண்டும் திற',
    languageRestartHintBack: '{language} · தளவமைப்பை மீட்க பாக்கியை மீண்டும் திற',
    restartTitle: 'பாக்கியை மூடித் திறக்கவும்',
    restartNow: 'பாக்கியை மறுதொடக்கம் செய்',
    restartNowMirror: 'தளவமைப்பைப் பிரதிபலிக்க பாக்கியை இப்போதே மறுதொடக்கம் செய்யவா?',
    restartNowUnmirror: 'தளவமைப்பை மீண்டும் மாற்ற பாக்கியை இப்போதே மறுதொடக்கம் செய்யவா?',
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
    emailSection: 'மின்னஞ்சல் வழியாக',
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
    phonePlaceholder: '{code} 98765 43210',
    codeEmailed: 'மின்னஞ்சலில் அனுப்பிய ஆறு இலக்கக் குறியீட்டை உள்ளிடவும்',
    codeTexted: 'குறுஞ்செய்தியில் அனுப்பிய ஆறு இலக்கக் குறியீட்டை உள்ளிடவும்',
    verificationCode: 'சரிபார்ப்புக் குறியீடு',
    confirm: 'உறுதிப்படுத்து',
    sendCodeEmail: 'எனக்கு ஒரு குறியீடு அனுப்பு',
    sendCodePhone: 'குறுஞ்செய்தியில் குறியீடு அனுப்பு',
    useDifferent: 'வேறொன்றைப் பயன்படுத்து',
    added: 'சேர்க்கப்பட்டது. இப்போது வேறு ஃபோனிலும் இதைக் கொண்டு உள்நுழையலாம்.',
    signInMethodsTitle: 'உள்நுழையும் வழிகள்',
    signInMethodsBody: 'ஒரு கணக்கை இணைத்தால், அடுத்த முறை எந்த ஃபோனிலும் அதன் மூலம் உள்நுழையலாம்.',
    link: 'இணை',
    linked: 'இணைக்கப்பட்டது',
    footnote:
      'உள்ளே விடுவதற்கு பாக்கி இதை ஒருபோதும் கேட்பதில்லை, உங்கள் குழுக்களில் உள்ள யாருடனும் இதைப் பகிர்வதும் இல்லை. நீங்கள் தேர்ந்தெடுத்த பெயரை மட்டுமே மற்றவர்கள் பார்ப்பார்கள்.',
    gateTitle: 'தொடர உங்கள் கணக்கை வைத்திருங்கள்',
    gateGroupBody:
      'விருந்தினராக ஒரு குழுவில் உள்ளீர்கள். மேலும் குழுக்களைத் தொடங்கவோ சேரவோ ஒரு மின்னஞ்சல், ஃபோன் அல்லது வழங்குநரைச் சேர்க்கவும் — நீங்கள் சேர்த்த அனைத்தும் உங்களுடன் இருக்கும்.',
    gateExpiredBody:
      'உங்கள் விருந்தினர் காலம் முடிந்துவிட்டது, எனவே இப்போது ஆப் படிக்க மட்டுமே. தொடர்ந்து சேர்க்க உள்நுழையும் வழியைச் சேர்க்கவும் — உங்கள் குழுக்களும் செலவுகளும் இங்கேயே உள்ளன.',
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
    useAPassword: 'மின்னஞ்சல் அல்லது கடவுச்சொல்',
    phoneNumber: 'தொலைபேசி எண்',
    countryCodeHint:
      'நாட்டுக் குறியீட்டுடன் தொடங்குங்கள். பாக்கி +91 என்று ஊகிப்பதே இல்லை — வெளிநாட்டு எண்கள் வருவது பயணத்தின்போதுதான்.',
    sendCode: 'குறியீடு அனுப்பு',
    codeSentTo: '{value} க்கு குறியீடு அனுப்பப்பட்டது',
    verify: 'சரிபார்',
    differentNumber: 'வேறு எண்ணைப் பயன்படுத்து',
    identifier: 'மின்னஞ்சல் அல்லது தொலைபேசி எண்',
    identifierPlaceholder: 'alex@example.com அல்லது {code}…',
    password: 'கடவுச்சொல்',
    passwordHint:
      'எட்டு எழுத்துகள் அல்லது அதற்கு மேல். நினைவில் நிற்கும் சொற்றொடர், நினைவில் நிற்காத புதிரை விட மேல்.',
    addToAccount: 'இதை என் கணக்கில் சேர்',
    createAccount: 'கணக்கை உருவாக்கு',
    signInAction: 'உள்நுழை',
    switchToSignIn: 'ஏற்கனவே கணக்கு உள்ளதா? உள்நுழையவும்',
    switchToSignUp: 'புதியவரா? கணக்கை உருவாக்கவும்',
    continueGoogle: 'Google மூலம் தொடர்',
    signInGoogle: 'Google மூலம் உள்நுழை',
    continueApple: 'Apple மூலம் தொடர்',
    signInApple: 'Apple மூலம் உள்நுழை',
    orSignInWith: 'அல்லது இதன் மூலம் உள்நுழை',
    continueGuest: 'விருந்தினராகத் தொடர்',
    guestFootnote:
      'நீங்கள் ஏற்கனவே சேர்த்த அனைத்தும் அப்படியே இருக்கும். இது மீண்டும் உள்நுழைய ஒரு வழியை மட்டுமே சேர்க்கிறது.',
    memberFootnote:
      'உள்நுழைய ஒரு வழியைச் சேர்க்கும் வரை விருந்தினர் கணக்கு அனைத்தையும் இந்தச் சாதனத்திலேயே வைத்திருக்கும். உங்கள் கணக்கு எப்போதும் பணயம் வைக்கப்படுவதில்லை.',
    couldNotSignIn: 'உள்நுழைய முடியவில்லை. மீண்டும் முயற்சிக்கவும்.',
    restartToMirror: 'தளவமைப்பைப் பிரதிபலிக்க பாக்கியை ஒருமுறை மூடித் திறக்கவும்.',
    restartToUnmirror: 'தளவமைப்பை மீண்டும் மாற்ற பாக்கியை ஒருமுறை மூடித் திறக்கவும்.',
  },
  tabs: {
    guestBanner: 'நீங்கள் பாக்கியை விருந்தினராகப் பயன்படுத்துகிறீர்கள்',
    guestBannerBody:
      'எதுவும் விடுபடவில்லை — நீங்கள் சேர்ப்பவை அனைத்தும் சேமிக்கப்பட்டு உங்களுடையவை. வேறு ஃபோனிலிருந்து அணுக விரும்பும்போது மின்னஞ்சலையோ தொலைபேசி எண்ணையோ சேர்க்கவும்.',
    guestDaysLeft: 'விருந்தினராக இன்னும் {days} நாட்கள் — அதன் பிறகு தொடர உள்நுழையவும்.',
    guestReadOnly:
      'உங்கள் விருந்தினர் காலம் முடிந்தது — ஆப் படிக்க மட்டுமே. தொடர்ந்து சேர்க்க உள்நுழையவும்.',
    addYourDetails: 'உங்கள் விவரங்களைச் சேர்',
    loadingGroups: 'உங்கள் குழுக்கள் ஏற்றப்படுகின்றன…',
    noGroups: 'இன்னும் குழுக்கள் இல்லை',
    noGroupsBody:
      'ஒரு பயணத்துக்கோ, வீட்டுக்கோ, இருவருக்கோ ஒன்றைத் தொடங்குங்கள். செலவுகளைச் சேர்ப்பது எப்போதும் இலவசம், வரம்பில்லாதது.',
    activityEmptyBody:
      'ஒவ்வொரு செலவும், திருத்தமும், நீக்கமும், தீர்வும் இங்கே வந்து சேரும் — குழுவில் உள்ள அனைவருக்கும்.',
    quickActions: 'விரைவுச் செயல்கள்',
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
  dashHero: {
    scanTitle: 'ரசீதைப் படம் எடுங்கள்',
    scanBody: 'பில்லை ஸ்கேன் செய்தால் பொருட்கள் தானாக நிரம்பும் — நொடிகளில் பங்கிடுங்கள்.',
    scanCta: 'ஸ்கேன்',
    inviteTitle: 'சேர்ந்து கணக்கு தீர்க்கலாம்',
    inviteBody: 'செலவுகளைப் பகிர்பவர்களைச் சேர்த்து அனைவரையும் சரிசெய்யுங்கள்.',
    inviteCta: 'ஒருவரைச் சேர்',
  },
  mergePeople: {
    entry: 'நபர்களை இணை',
    title: 'நபர்களை இணை',
    subtitle:
      'ஒரே நபராக இருக்கும் விருந்தினர்களைத் தேர்ந்தெடுக்கவும். அவர்களின் இருப்புகள் ஒரே பெயரின் கீழ் இணைக்கப்படும்.',
    empty: 'இணைக்க விருந்தினர்கள் இல்லை — Baaki கணக்கு இல்லாதவர்களை மட்டுமே இணைக்க முடியும்.',
    nameLabel: 'இணைந்த நபருக்கான பெயர்',
    namePlaceholder: 'எ.கா. ரவி',
    warningTitle: 'இதை மீட்டெடுக்க முடியாது',
    warningBody:
      'அவர்களின் தனித்தனி இருப்புகள் நிரந்தரமாக ஒரே நபராக இணைக்கப்படும். மீண்டும் பிரிக்க வழி இல்லை.',
    cta: 'இணை',
    selected: {
      one: '{n} நபர் தேர்ந்தெடுக்கப்பட்டார்',
      other: '{n} நபர்கள் தேர்ந்தெடுக்கப்பட்டனர்',
    },
    merged: '{name} ஆக இணைக்கப்பட்டது',
    errorTooFew: 'இணைக்க குறைந்தது இரண்டு நபர்களைத் தேர்ந்தெடுக்கவும்.',
    errorNotMergeable: 'நீங்கள் பகிரும் குழுவில் உள்ள விருந்தினர்களை மட்டுமே இணைக்க முடியும்.',
    errorNameRequired: 'இணைந்த நபருக்கு ஒரு பெயரைக் கொடுக்கவும்.',
    errorGeneric: 'இணைக்க முடியவில்லை. மீண்டும் முயற்சிக்கவும்.',
  },
  groupPhoto: {
    paidHint:
      'குழு புகைப்படங்கள் Plus அம்சம். ஒரு ஐகானைத் தேர்ந்தெடுக்கவும், அல்லது புகைப்படம் சேர்க்க மேம்படுத்தவும்.',
  },
  inbox: {
    title: 'அஞ்சல் பெட்டி',
    nothingYetBody:
      'நினைவூட்டல்கள், தீர்வு உறுதிப்படுத்தல்கள், பாக்கி உங்களிடம் சொல்லும் மற்ற அனைத்தும் இங்கே சேரும் — அறிவிப்பு உங்கள் ஃபோனுக்கு வராவிட்டாலும் கூட.',
    recent: 'சமீபத்தியவை',
  },
  captures: {
    title: 'விரைவுப் பதிவுகள்',
    captureCta: 'ஒரு செலவைப் பதிவு செய்யுங்கள்',
    newTitle: 'ஒரு செலவைப் பதிவு செய்யுங்கள்',
    emptyTitle: 'இன்னும் எதுவும் பதிவாகவில்லை',
    emptyBody:
      'செலவு நடந்த அந்த நொடியிலேயே பிடித்து வையுங்கள் — தொகை, ஒரு குறிப்பு, ரசீதின் படம் — எந்தக் குழுவுக்கு உரியது என்பதைப் பிறகு தீர்மானியுங்கள்.',
    amount: 'தொகை',
    description: 'இது என்ன?',
    descriptionPlaceholder: 'காபி, டாக்ஸி, மளிகை…',
    category: 'எதற்காக?',
    date: 'தேதி',
    receipt: 'ரசீது',
    addReceipt: 'ரசீதைச் சேர்',
    reading: 'படிக்கிறது…',
    notSynced: 'இன்னும் ஒத்திசைக்கவில்லை',
    assign: 'குழுவுக்கு ஒதுக்கு',
    assignTitle: 'ஒரு குழுவுக்கு ஒதுக்குங்கள்',
    assignBody:
      'இது எந்தக் குழுவுக்கு உரியது என்பதைத் தேர்ந்தெடுங்கள். யார் கட்டினார், எப்படிப் பிரிக்கிறது என்பதை அடுத்து அமைக்கலாம்.',
    noGroups: 'உங்களிடம் இன்னும் குழுக்கள் இல்லை. முதலில் ஒன்றை உருவாக்கி, பிறகு இதை ஒதுக்குங்கள்.',
    delete: 'நீக்கு',
    deleteConfirm: 'இந்தப் பதிவை நீக்கவா? தொகையும் ரசீதுப் படமும் சேர்ந்து போகும்.',
    unassigned: 'ஒதுக்கப்படாதவை',
    unassignedBody: {
      one: 'குழுவுக்காகக் காத்திருக்கும் {n} பதிவு',
      other: 'குழுவுக்காகக் காத்திருக்கும் {n} பதிவுகள்',
    },
    itemizedTitle: 'உருப்படிகள்',
    itemCount: {
      one: '{n} உருப்படி',
      other: '{n} உருப்படிகள்',
    },
    couldNotRead: 'இந்த ரசீதைப் படிக்க முடியவில்லை — தொகையை நீங்களே உள்ளிடவும்.',
    savedOnDevice: 'இந்தச் சாதனத்தில் சேமிக்கப்பட்டது',
    save: 'சேமி',
  },
  backup: {
    title: 'ரசீது காப்புப்படி',
    subtitle: 'ஸ்கேன் செய்த ரசீதுகளை உங்கள் சொந்த கிளவுடில் வைத்திருங்கள்',
    primaryTitle: 'ரசீதுகளை காப்புப்பிடி',
    primaryBody:
      'ஸ்கேன் செய்த ரசீதுகள் இந்தச் சாதனத்தில் சேமிக்கப்பட்டு நீங்கள் தேர்ந்தெடுத்த கிளவுடுக்கு நகலெடுக்கப்படும். அவை Baaki சேவையகங்களைத் தொடாது.',
    off: 'அணை',
    connect: 'இணை',
    disconnect: 'துண்டி',
    connected: 'இணைக்கப்பட்டது',
    notConfigured: 'இந்த பதிப்பில் அமைக்கப்படவில்லை',
    networkTitle: 'இதன் மூலம் பதிவேற்று',
    wifiOnly: 'வைஃபை மட்டும்',
    wifiAndData: 'வைஃபை & மொபைல் டேட்டா',
    pending: {
      one: '{n} ரசீது காப்புப்படிக்கக் காத்திருக்கிறது',
      other: '{n} ரசீதுகள் காப்புப்படிக்கக் காத்திருக்கின்றன',
    },
    allBackedUp: 'அனைத்து ரசீதுகளும் காப்புப்படி எடுக்கப்பட்டன',
    privacyNote:
      'புகைப்படம் உங்கள் ஃபோனிலும் நீங்கள் தேர்ந்தெடுத்த கிளவுடிலும் இருக்கும். Baaki நீங்கள் சேமிக்கும் தொகையை மட்டுமே பார்க்கும்.',
  },
  group: {
    notFound: 'குழு கிடைக்கவில்லை',
    notFoundBody: 'அது காப்பகப்படுத்தப்பட்டிருக்கலாம், அல்லது நீங்கள் இனி உறுப்பினர் இல்லை.',
    notFoundArchived: 'அது காப்பகப்படுத்தப்பட்டிருக்கலாம்.',
    loading: 'ஏற்றப்படுகிறது…',
    settings: 'குழு அமைப்புகள்',
    more: 'மேலும்',
    mismatch: 'இருப்புகளைப் புதுப்பிக்க வேண்டும்',
    mismatchBody:
      'இந்தக் குழுவின் இருப்புகள் குறித்து இந்தச் சாதனமும் சர்வரும் ஒத்துப்போகவில்லை. இழுத்துப் புதுப்பிக்கவும்; தொடர்ந்தால் கீழே உள்ள கணக்கே சரியானது.',
    confirmReceived: 'கிடைத்தது என்று உறுதிப்படுத்து',
    saysTheyPaidYou: '{name} உங்களுக்குப் பணம் கொடுத்ததாகச் சொல்கிறார்',
    autoConfirms: 'யாரும் பதிலளிக்காவிட்டால் 7 நாட்களில் தானாகவே உறுதியாகும்.',
    hideDeleted: 'நீக்கியவற்றை மறை',
    showDeleted: 'நீக்கியவற்றைக் காட்டு',
    activityEmptyBody: 'இங்கே நடக்கும் அனைத்தும் இந்தப் பட்டியலில் தோன்றும்.',
    photoUpdated: 'புகைப்படம் புதுப்பிக்கப்பட்டது',
    nameOptional: 'பெயர் (விருப்பம்)',
    groupName: 'குழுவின் பெயர்',
    saveName: 'பெயரைச் சேமி',
    chooseIcon: 'ஐகானைத் தேர்ந்தெடு',
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
    archivedTitle: 'காப்பகக் குழுக்கள்',
    archivedEmpty: 'காப்பகத்தில் ஏதுமில்லை',
    archivedEmptyBody:
      'நீங்கள் காப்பகப்படுத்தும் குழுக்கள் இங்கே தோன்றும், மீண்டும் கொண்டுவரத் தயார்.',
    unarchive: 'மீட்டெடு',
    archivedOn: '{date} அன்று காப்பகப்படுத்தப்பட்டது',
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
    role: 'பங்கு',
    makeAdmin: 'நிர்வாகியாக்கு',
    removeAdmin: 'நிர்வாகியை நீக்கு',
    adminNote:
      'நிர்வாகிகள் குழுவைத் திருத்தலாம், உறுப்பினர்களை நிர்வகிக்கலாம், மொத்த பட்ஜெட்டை அமைக்கலாம்.',
    adminNeedsAccount:
      'இவர் இன்னும் சேரவில்லை. கணக்கு உள்ள உறுப்பினர் மட்டுமே நிர்வாகியாக முடியும்.',
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
    usesBadge: '{count} பயன்பாடுகள்',
    shareMessage:
      'செலவுகளைப் பிரிக்க Baaki-ல் {group} குழுவில் சேரவும் — தொடங்க ஆப் அல்லது கணக்கு தேவையில்லை: {link}',
    emailSubject: 'Baaki-ல் {group} குழுவில் சேரவும்',
    mintMistakeNote:
      'தவறுதலாக இணைப்பு உருவாக்கினீர்களா? புதிதாக ஒன்றை உருவாக்கவும் — பழைய இணைப்பு காலாவதியாகும் வரை வேலை செய்யும், எனவே நீங்கள் நினைத்த இணைப்புகளை மட்டும் பகிரவும்.',
    hideContacts: 'தொடர்புகளை மறை',
    browseContacts: 'என் தொடர்புகளைப் பார்',
    contacts: 'தொடர்புகள்',
    remind: 'நினைவூட்டு',
    reminded: 'நினைவூட்டப்பட்டது',
    remindedToday: 'இன்று நினைவூட்டிவிட்டீர்கள்',
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
    aBill: 'ஒரு பில்',
    splitBillA11y: '{merchant} பொருள் வாரியாகப் பிரி',
    receiptClaimedNone: {
      one: '{n} வரி, இன்னும் யாரும் உரிமை கோரவில்லை. நீங்கள் சாப்பிட்டதைத் தட்டவும்.',
      other: '{n} வரிகள், இன்னும் யாரும் உரிமை கோரவில்லை. நீங்கள் சாப்பிட்டதைத் தட்டவும்.',
    },
    receiptClaimedSome:
      '{items} இல் {claimed} வரிகள் உரிமை கோரப்பட்டன. நீங்கள் சாப்பிட்டதைத் தட்டவும்.',
    scanReadItemsCta: {
      one: '{n} வரி படிக்கப்பட்டது — பதிலாக பொருள் வாரியாகப் பிரி',
      other: '{n} வரிகள் படிக்கப்பட்டன — பதிலாக பொருள் வாரியாகப் பிரி',
    },
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
    disputed: 'மறுப்பு',
    untitled: 'பெயரிடப்படாதது',
    paidByName: '{name} கொடுத்தார்',
    editedTimes: { one: 'ஒருமுறை திருத்தப்பட்டது', other: '{n} முறை திருத்தப்பட்டது' },
    inCount: { one: '{n} செலவில்', other: '{n} செலவுகளில்' },
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
    peopleSplitting: {
      one: '{n} நபர் இங்கே செலவுகளைப் பகிர்கிறார்',
      other: '{n} பேர் இங்கே செலவுகளைப் பகிர்கிறார்கள்',
    },
    peopleCount: { one: '{n} நபர்', other: '{n} பேர்' },
    contactsAdded:
      '{count} சேர்க்கப்பட்டனர். வேறு ஒருவரைத் தேர்ந்தெடுக்கவும், அல்லது பின் செல்லவும்.',
    couldNotAdd: '{names} சேர்க்க முடியவில்லை.',
    couldNotAddSome: 'எல்லாரையும் சேர்க்க முடியவில்லை. {reason}',
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
    notSentYet: 'இன்னும் அனுப்பப்படவில்லை',
    offlineWithCount: {
      one: 'இணைப்பு இல்லை — {n} மாற்றம் இந்த ஃபோனில் சேமிக்கப்பட்டுள்ளது',
      other: 'இணைப்பு இல்லை — {n} மாற்றங்கள் இந்த ஃபோனில் சேமிக்கப்பட்டுள்ளன',
    },
    cantReachServer: {
      one: 'சர்வரை அடைய முடியவில்லை — {n} மாற்றம் இங்கே சேமிக்கப்பட்டு காத்திருக்கிறது',
      other: 'சர்வரை அடைய முடியவில்லை — {n} மாற்றங்கள் இங்கே சேமிக்கப்பட்டு காத்திருக்கின்றன',
    },
    syncingCount: {
      one: '{n} மாற்றம் அனுப்பப்படுகிறது…',
      other: '{n} மாற்றங்கள் அனுப்பப்படுகின்றன…',
    },
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
    dictationErrors: {
      notAllowed: 'மைக்ரோஃபோனைப் பயன்படுத்த பாக்கிக்கு அனுமதி தேவை. அமைப்புகளில் அதை இயக்கலாம்.',
      noSpeech: 'எதுவும் கேட்கவில்லை. மைக்கைத் தட்டி மீண்டும் பேசுங்கள்.',
      audioBusy:
        'மைக்ரோஃபோன் பயன்பாட்டில் உள்ளது. பதிவு செய்யும் மற்றதை மூடிவிட்டு மீண்டும் முயற்சிக்கவும்.',
      network: 'இந்தப் ஃபோனில் பேச்சு அறிதலுக்கு இணைப்பு தேவை. குறிப்பைத் தட்டச்சு செய்யுங்கள்.',
      languageNotSupported:
        'இந்த ஃபோன் அந்த மொழியை இன்னும் அறிய முடியாது. குறிப்பைத் தட்டச்சு செய்யுங்கள்.',
      stopped: 'சொல்வது நின்றது. குறிப்பைத் தட்டச்சு செய்யுங்கள்.',
    },
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
    withLabel: 'உடன்',
    settleNoDetailsTitle: '{rail} விவரங்கள் இன்னும் இல்லை',
    settleNoDetailsBody:
      '{name} தாங்கள் எப்படி பணம் பெறுகிறார்கள் என்பதைச் சேர்க்கவில்லை. பணமாகத் தீர்த்துக்கொள்ளுங்கள் அல்லது அதைச் சேர்க்கச் சொல்லுங்கள்.',
    settleRailFallback: 'கட்டணம்',
    settlePayTitle: '{name}க்குச் செலுத்து',
    settlePayBody: '{rail}\n{handle}\n\nபிறகு திரும்பி வந்து பதிவு செய்யுங்கள்.',
    settleSendTo: 'இதற்கு அனுப்பு',
    recordYes: 'ஆம், பதிவு செய்',
    recordNo: 'இல்லை',
    recordIt: 'பதிவு செய்',
    noReasonGiven: 'காரணம் எதுவும் தரப்படவில்லை',
    disputeStands:
      'இன்னும் எதுவும் மாறவில்லை — செலவு திருத்தப்படும் வரை உங்கள் பங்கு நிலைக்கும். இது வேண்டுமென்றே: யாரும் தாமாகவே நீக்கக்கூடிய பங்கு ஒரு கணக்கேடாக இருக்காது.',
    neverMind: 'பரவாயில்லை, சரிதான்',
    whatsWrongWithIt: 'இதில் என்ன தவறு?',
    somethingsWrong: 'ஏதோ தவறு',
    tripDatesTitle: 'பயணத் தேதிகள்',
    aboutTripDates: 'பயணத் தேதிகள் பற்றி',
    tripDatesBody:
      'பயணம் நடக்கும்போது, செலவழித்ததைச் சேர்க்க அனைவருக்கும் நினைவூட்டல் வரும் — காலை உணவின்போது நேற்றைக்கும், நாள் முடிவில் இன்றைக்கும். ஏற்கனவே சேர்த்த நாளைப் பற்றி யாரையும் கேட்கப்படாது.',
    bankRateNote:
      'உங்கள் வங்கியின் விகிதம், கூடுதல் கட்டணம் உட்பட — இதுதான் உங்கள் அறிக்கையில் இருக்கும்.',
    listening: 'கேட்கிறது…',
    whereSettle: 'இந்தக் குழு எங்கே தீர்த்துக்கொள்கிறது?',
    youHaveVersion: 'உங்களிடம் {installed} உள்ளது',
    versionAvailable: ' · {latest} கிடைக்கிறது',
    gotIt: 'சரி',
    copied: 'நகலெடுக்கப்பட்டது',
    tapToCopy: 'நகலெடுக்க பொத்தானைத் தட்டவும்',
    insightsLiveNote:
      'நேரடிச் செலவுகள் மட்டும் — திருத்தப்பட்ட செலவு இப்போது சொல்வதன்படி கணக்கிடப்படும், நீக்கப்பட்டது கணக்கில் வராது. தொகைகள் நாணயங்களுக்கிடையே மாற்றப்படாது.',
    nameAloneBody:
      'ஒரு பெயர் மட்டும் போதும் — பிரிவில் பங்கேற்க யாருக்கும் ஆப் அல்லது மின்னஞ்சல் தேவையில்லை. முகவரி என்பது அவர்களுக்கு இணைப்பை அனுப்பலாம் என்பதுதான். பின்னர் அவர்கள் சேரும்போது தங்கள் பெயரில் பதிவான அனைத்தையும் உரிமை கொள்ளலாம்.',
    noUpiYet: 'இன்னும் UPI ஐடி இல்லை',
    csvCurrencyMismatch:
      'இந்தக் கோப்பு {fileCur} இல் உள்ளது, இந்தக் குழு தன் பணத்தை {groupCur} இல் வைத்திருக்கிறது. இதை இறக்குமதி செய்ய ஒவ்வொரு வரிசைக்கும் ஒரு விகிதம் தேவை, கோப்பு அதைக் கொண்டிருக்கவில்லை — அதற்குப் பதிலாக ஒரு {fileCur} குழுவைத் தொடங்குங்கள்.',
    rateFetchFailedSuffix: ' — நீங்கள் விகிதத்தை நேரடியாகத் தட்டச்சு செய்யலாம்',
    settlesInHint: 'இந்தக் குழு {currency} இல் தீர்க்கிறது',
    howDoYouKnowRate:
      'இந்தக் குழு {currency} இல் தீர்க்கிறது. விகிதம் உங்களுக்கு எப்படித் தெரியும்?',
    todaysRate: 'இன்றைய விகிதம்',
    statementAmountLabel: 'உங்கள் அறிக்கையில் உள்ள தொகை, {currency} இல்',
    amountChargedIn: '{currency} இல் வசூலிக்கப்பட்ட தொகை',
    fxOneEquals: '1 {from} = ? {to}',
    fxRateFromTo: '{from} இலிருந்து {to} க்கு விகிதம்',
    convertedApprox: '≈ {amount} ({currency} இல்)',
    rateStoredNote:
      'விகிதம் {rate}, {source} இலிருந்து. செலவுடன் சேமிக்கப்படுகிறது, எனவே பின்னரும் இதே போல் மாற்றப்படும்.',
    rateSourceEcb: 'ECB',
    rateSourceImplied: 'உங்கள் அறிக்கை',
    rateSourceYou: 'நீங்கள்',
    noRateNote:
      'விகிதம் இல்லாமலும் செலவு சேமிக்கப்படும் — அது {currency} இல் இருக்கும், மேலும் குழு ஒரு தனி {currency} இருப்பை வைத்திருக்கும்.',
    thinkThisOff: {
      one: 'இது சரியில்லை என ஒருவர் நினைக்கிறார்',
      other: 'இது சரியில்லை என {n} பேர் நினைக்கிறார்கள்',
    },
    sending: 'அனுப்புகிறது…',
    tellThem: 'அவர்களிடம் சொல்',
    versionStoppedBody:
      'இந்தப் பதிப்பால் இனி பாக்கியுடன் தொடர்பு கொள்ள முடியாது, எனவே தவறாக இருக்கக்கூடிய எண்களைக் காட்டுவதற்குப் பதிலாக அது நிறுத்தப்பட்டுள்ளது.',
    newBaakiOut: 'புதிய பாக்கி வெளியாகிவிட்டது',
    baakiVersionOut: 'பாக்கி {latest} வெளியாகிவிட்டது',
  },
  smsImport: {
    title: 'செய்திகளிலிருந்து இறக்குமதி',
    howTo:
      'உங்கள் செய்தி செயலியைத் திறந்து, இந்தப் பயணத்தின் வங்கிச் செய்திகளைத் தேர்ந்தெடுத்து, நகலெடுத்து இங்கே ஒட்டுங்கள். பாக்கி அவற்றை இந்த ஃபோனிலேயே படிக்கும் — நீங்கள் ஒரு செலவை உறுதி செய்யும் வரை எதுவும் எங்கும் அனுப்பப்படாது.',
    whyNotAutomatic:
      'பாக்கியால் உங்கள் இன்பாக்ஸைத் தானாகப் படிக்க முடியாது. iPhone எந்தச் செயலிக்கும் அந்த அனுமதியைத் தராது; Android இல் அது உங்கள் செய்தி செயலிக்கு மட்டுமே உரியது.',
    messagesSection: 'செய்திகள்',
    pasteLabel: 'வங்கிச் செய்திகளை ஒட்டு',
    pastePlaceholder: 'இங்கே ஒட்டவும்.\n\nசெய்திகளுக்கு இடையே ஒரு காலி வரி விடவும்.',
    nothingPasted: 'இன்னும் எதுவும் ஒட்டப்படவில்லை',
    messageCount: { one: '{n} செய்தி', other: '{n} செய்திகள்' },
    paste: 'ஒட்டு',
    datesSection: 'இந்தத் தேதிகளுக்கு இடையே',
    datesNote:
      'இந்த இடைவெளிக்குள் உள்ள கொடுப்பனவுகள் மட்டுமே பரிந்துரைக்கப்படும், எனவே உங்கள் இன்பாக்ஸின் மீதி குழுவுக்கு வெளியேயே இருக்கும்.',
    from: 'முதல்',
    to: 'வரை',
    last7: 'கடந்த 7 நாட்கள்',
    last30: 'கடந்த 30 நாட்கள்',
    datePlaceholder: 'YYYY-MM-DD',
    dateFieldLabel: '{label} தேதி, ஆண்டு மாதம் நாள்',
    foundSection: 'கிடைத்தவை',
    nothingToImport: 'இறக்குமதி செய்ய எதுவும் இல்லை',
    nothingLikeAPayment:
      'அந்தச் செய்திகளில் எதுவும் இந்தத் தேதிகளுக்குள் ஒரு கொடுப்பனவாகத் தெரியவில்லை. நினைவூட்டல்கள், ஒருமுறைக் கடவுச்சொற்கள், வரும் பணம் — இவை வேண்டுமென்றே விடப்படுகின்றன.',
    allAnotherCurrency: 'கிடைத்த ஒவ்வொரு கொடுப்பனவும் வேறு நாணயத்தில் இருந்தது.',
    cardPayment: 'அட்டைக் கொடுப்பனவு',
    selected: 'தேர்ந்தெடுக்கப்பட்டது',
    notSelected: 'தேர்ந்தெடுக்கப்படவில்லை',
    checkThis: 'இதைச் சரிபார்',
    otherCurrencyNote: {
      one: '{n} கொடுப்பனவு வேறு நாணயத்தில் இருந்தது. அதைக் கையால் சேருங்கள் — உங்களுக்கு எந்த விகிதம் விதிக்கப்பட்டது என்பதை அந்தச் செய்தி சொல்லவில்லை, இந்தக் குழு {currency} இல் கணக்கு வைக்கிறது.',
      other:
        '{n} கொடுப்பனவுகள் வேறு நாணயத்தில் இருந்தன. அவற்றைக் கையால் சேருங்கள் — உங்களுக்கு எந்த விகிதம் விதிக்கப்பட்டது என்பதை அந்தச் செய்திகள் சொல்லவில்லை, இந்தக் குழு {currency} இல் கணக்கு வைக்கிறது.',
    },
    whoPaidSection: 'யார் கொடுத்தார்கள்',
    whoPaidNote:
      'வங்கிச் செய்தி உங்கள் கணக்கிலிருந்து என்ன போனது என்று சொல்கிறது, யார் இருந்தார்கள் என்று அல்ல. இவை குழுவில் உள்ள அனைவருக்கும் சமமாகப் பிரிக்கப்படும் — பிறகு எதையும் மாற்றலாம்.',
    addedCount: {
      one: '{n} செலவு சேர்க்கப்பட்டது. அது இந்த ஃபோனில் சேமிக்கப்பட்டுள்ளது, இணைப்பு கிடைத்ததும் ஒத்திசைக்கும்.',
      other:
        '{n} செலவுகள் சேர்க்கப்பட்டன. அவை இந்த ஃபோனில் சேமிக்கப்பட்டுள்ளன, இணைப்பு கிடைத்ததும் ஒத்திசைக்கும்.',
    },
    adding: 'சேர்க்கிறது…',
    nothingSelected: 'எதுவும் தேர்ந்தெடுக்கப்படவில்லை',
    addCount: { one: '{n} செலவைச் சேர்', other: '{n} செலவுகளைச் சேர்' },
    readMessages: 'என் செய்திகளைப் படி',
    reading: 'படிக்கிறது…',
    readOnAndroid:
      'Android-இல், இந்தத் தேதிகளில் உள்ள வங்கிச் செய்திகளை பாக்கி உங்களுக்காகப் படிக்கும். முதலில் அனுமதி கேட்கும், இந்த ஃபோனிலேயே படிக்கும், நீங்கள் உறுதிப்படுத்தும் வரை எதுவும் எங்கும் அனுப்பப்படாது.',
    readCount: {
      one: 'உங்கள் இன்பாக்ஸிலிருந்து {n} செய்தி படிக்கப்பட்டது.',
      other: 'உங்கள் இன்பாக்ஸிலிருந்து {n} செய்திகள் படிக்கப்பட்டன.',
    },
    readNothing: 'இந்தத் தேதிகளில் வங்கிச் செய்திகள் எதுவும் இல்லை.',
    permissionDenied:
      'செய்திகளைப் படிக்க பாக்கிக்கு உங்கள் அனுமதி தேவை. அதற்குப் பதிலாக கீழே ஒட்டலாம்.',
    permissionBlocked:
      'பாக்கிக்கு செய்தி அணுகல் அணைக்கப்பட்டுள்ளது. அமைப்புகள் › ஆப்ஸ் › Baaki › அனுமதிகள் இல் இயக்கவும், அல்லது கீழே செய்திகளை ஒட்டவும்.',
    readUnsupported:
      'செய்திகளைப் படிப்பது Android-இல் மட்டுமே இயங்கும். அதற்குப் பதிலாக கீழே ஒட்டவும்.',
    readUnavailable: 'இந்தப் பதிப்பால் செய்திகளைப் படிக்க முடியாது. கீழே ஒட்டவும்.',
    readFailed: 'உங்கள் செய்திகளைப் படிக்க முடியவில்லை. கீழே ஒட்டவும்.',
    permissionRationale: {
      title: 'வங்கிச் செய்திகளைப் படிக்க',
      message:
        'உங்கள் பயணத்திற்கான செலவுகளைப் பரிந்துரைக்க பாக்கி இந்த ஃபோனில் உள்ள வங்கிப் பணச் செய்திகளைப் படிக்கிறது. செய்திகள் உங்கள் ஃபோனிலேயே இருக்கும் — நீங்கள் ஒரு செலவை உறுதிப்படுத்தும் வரை எதுவும் எங்கும் அனுப்பப்படாது.',
      allow: 'அனுமதி',
      notNow: 'இப்போது வேண்டாம்',
    },
    dateNotInMessage: 'செய்தியில் தேதி இல்லை',
  },
  itemize: {
    title: 'பொருள் வாரியாகப் பிரி',
    notAMember: 'நீங்கள் இந்தக் குழுவின் உறுப்பினர் அல்ல',
    invalidTaxOrTip: 'வரி மற்றும் டிப்பிற்கு சரியான தொகையை உள்ளிடவும்.',
    defaultDescription: 'பொருள் வாரியான ரசீது',
    sharedNow:
      'இப்போது குழுவில் உள்ள அனைவரும் இந்த ரசீதைப் பார்க்கலாம். நீங்கள் சாப்பிட்ட வரிகளைத் தட்டுங்கள்.',
    splittingTogether: 'சேர்ந்து பிரிக்கிறோம்',
    splittingTogetherNote:
      'குழுவில் உள்ள அனைவரும் இந்த வரிகளைப் பார்க்கிறார்கள். நீங்கள் சாப்பிட்டதைத் தட்டுங்கள் — நீங்கள் செய்யும்போதே அவர்கள் பார்ப்பார்கள். ஒவ்வொரு உரிமைக்கோரலும் அதன் வரியுடன் இணைந்திருப்பதால், வரிகளை இனி மாற்ற முடியாது.',
    everyoneHasAPhone: 'மேசையில் உள்ள அனைவரிடமும் ஃபோன் உள்ளதா?',
    handOverNote:
      'இந்த வரிகளைக் குழுவிடம் கொடுங்கள், ஒவ்வொருவரும் தங்கள் ஃபோனிலேயே தாங்கள் சாப்பிட்டதைத் தட்டுவார்கள். முதலில் வரிகளைச் சரிபாருங்கள் — யாரேனும் ஒன்றைக் கோரிவிட்டால் பட்டியல் நிலைத்துவிடும்.',
    sharing: 'பகிர்கிறது…',
    splitTogether: 'சேர்ந்து பிரி',
    whatWasTheBillFor: 'ரசீது எதற்காக?',
    descriptionPlaceholder: 'அஞ்சப்பரில் இரவு உணவு',
    descriptionLabel: 'ரசீது விவரம்',
    addALine: 'ஒரு வரியைச் சேர்',
    itemPlaceholder: 'பிரியாணி',
    itemName: 'பொருளின் பெயர்',
    itemAmount: 'பொருளின் தொகை',
    unclaimed: 'இதை யாரும் கோரவில்லை',
    splitWays: { one: 'ஒருவருக்கு', other: '{n} பேருக்குப் பிரிக்கப்பட்டது' },
    taxAndTipNote: 'வரியும் டிப்பும் — ஒவ்வொருவரும் ஆர்டர் செய்ததற்கு ஏற்ப பங்கிடப்படும்',
    taxRow: 'வரி / சேவை',
    tipRow: 'டிப்',
    taxAmount: 'வரித் தொகை',
    tipAmount: 'டிப் தொகை',
    total: 'மொத்தம்',
    someone: 'யாரோ',
    waitingForLines: 'இந்த ரசீதின் வரிகளுக்குக் காத்திருக்கிறது.',
    addTheLines: 'ரசீதிலிருந்து வரிகளைச் சேர்த்து, யார் என்ன சாப்பிட்டார்கள் என்று தட்டுங்கள்.',
    stillUnclaimed: {
      one: '{n} வரி இன்னும் கோரப்படவில்லை — யாரும் ஆர்டர் செய்யாத உணவுக்கு யாரும் பணம் தர வேண்டியதில்லை.',
      other:
        '{n} வரிகள் இன்னும் கோரப்படவில்லை — யாரும் ஆர்டர் செய்யாத உணவுக்கு யாரும் பணம் தர வேண்டியதில்லை.',
    },
    tapWhoHadEach: 'பிரிவைப் பார்க்க ஒவ்வொரு வரியையும் யார் சாப்பிட்டார்கள் என்று தட்டுங்கள்.',
    taxAndTipShared:
      '{amount} வரியும் டிப்பும் ஒவ்வொருவரின் பொருட்களுக்கு ஏற்ற விகிதத்தில் பங்கிடப்படுகிறது.',
    scanTitle: 'ரசீதை ஸ்கேன் செய்',
    scanBody:
      'பில்லை ஸ்கேன் செய்தால் வரிகள் தானாக நிரப்பப்படும். சேமிக்கும் முன் அவற்றைச் சரிபாருங்கள் — கையால் உள்ளிடுவது எப்போதும் இலவசம்.',
    scanReadItems: {
      one: '{n} வரி படிக்கப்பட்டது. அதைச் சரிபார்த்து, யார் என்ன சாப்பிட்டார் எனத் தட்டவும்.',
      other:
        '{n} வரிகள் படிக்கப்பட்டன. அவற்றைச் சரிபார்த்து, யார் என்ன சாப்பிட்டார் எனத் தட்டவும்.',
    },
    scanCheckLines: 'சேமிப்பதற்கு முன் சில வரிகளைச் சரிபார்க்க வேண்டும்.',
    carriedOver:
      'ஸ்கேனிலிருந்து கொண்டுவரப்பட்டது. வரிகளைச் சரிபார்த்து, யார் என்ன சாப்பிட்டார் எனத் தட்டவும்.',
    notYours: 'அவர்கள் Baaki-யில் உள்ளனர் — அவர்கள் தங்கள் வரிகளைத் தாங்களே தட்டுவார்கள்.',
    itemFallback: 'பொருள் {n}',
    removeItem: '{label} அகற்று',
    hadItem: '{name} {label} சாப்பிட்டார்',
  },
  importLedger: {
    splitwiseTitle: 'Splitwise ஏற்றுமதியை இறக்குமதி செய்',
    ledgerTitle: 'ஒரு கணக்கை இறக்குமதி செய்',
    splitwiseHowTo:
      'Splitwise இல் குழுவைத் திறந்து, Export as spreadsheet என்பதைத் தேர்ந்தெடுத்து, அந்தக் கோப்பை இங்கே தேர்வு செய்யுங்கள்.',
    bringHistory: 'உங்கள் வரலாற்றைக் கொண்டு வாருங்கள்',
    free: 'இலவசம்',
    ledgerHowTo:
      'Splitwise இலிருந்து: குழுவைத் திறந்து → ⚙ மெனு → Export as spreadsheet, அந்த CSV ஐ இங்கே தேர்வு செய்யுங்கள். பாக்கியிலிருந்து: அமைப்புகளிலிருந்து ஏற்றுமதி செய்த JSON கோப்பைத் தேர்வு செய்யுங்கள். அதில் பெயர் உள்ள அனைவரும் குழுவின் உறுப்பினராகிவிடுவார்கள் — அவர்களுக்குச் செயலி தேவையில்லை, சேரும்போது தங்கள் வரலாற்றைக் கோரலாம்.',
    chooseFile: 'ஒரு கோப்பைத் தேர்வு செய்',
    chosenFile: 'தேர்ந்தெடுத்தது: {name}',
    chooseDifferentFile: 'வேறு கோப்பைத் தேர்வு செய்',
    whichGroup: 'எந்தக் குழு',
    groupNumber: 'குழு {n}',
    whoIsWho: 'யார் யார்',
    whoIsWhoNote:
      'கோப்பில் பெயர்கள் உள்ளன; இந்தக் குழுவில் உறுப்பினர்கள் உள்ளனர். ஒவ்வொரு பெயருக்கும் ஒருவரைக் குறிக்கும் வரை எதுவும் இறக்குமதி ஆகாது.',
    tapANameNote:
      'இங்கே அவர்கள் யார் என்று சொல்ல ஒரு பெயரைத் தட்டுங்கள். உங்கள் சார்பாக யாரும் பெயரால் பொருத்தப்படுவதில்லை — இரண்டு பேர் ரவி என்று இருக்க முடியும்.',
    addAsNew: 'புதியவராகச் சேர்',
    newPerson: 'புதிய நபர்',
    importedGroup: 'இறக்குமதி செய்யப்பட்ட குழு',
    rowsLeftOut: 'விடப்பட்ட வரிசைகள்',
    rowsLeftOutNote:
      'மற்ற அனைத்தும் இறக்குமதி ஆகும். பின்னர் இவை இல்லை என்று கண்டுபிடிப்பதற்குப் பதிலாக, கையால் சேர்க்க முடியும் என்பதற்காகவே இவை பெயரிடப்பட்டுள்ளன.',
    fileWide: 'கோப்பு',
    rowNumber: 'வரிசை {n}',
    whereItGoes: 'எங்கே சேரும்',
    aNewGroup: 'ஒரு புதிய குழு',
    namedAfterFile: 'கோப்பின் பெயரில்',
    addToThisGroup: 'இந்தக் குழுவில் சேர்',
    importing: 'இறக்குமதி செய்கிறது…',
    importCount: { one: '{n} செலவை இறக்குமதி செய்', other: '{n} செலவுகளை இறக்குமதி செய்' },
    chooseWhoIs: '{name} யார் என்று தேர்ந்தெடுக்கவும்',
    chooseWhoArePlural: {
      one: '{n} நபர் யார் என்று தேர்ந்தெடுக்கவும்',
      other: '{n} நபர்கள் யார் என்று தேர்ந்தெடுக்கவும்',
    },
    tapYourNameFirst:
      'முதலில் உங்கள் பெயரைத் தட்டுங்கள் — இல்லையெனில் இந்த வரலாறு எதுவும் உங்களுடையது ஆகாது.',
    imported: 'இறக்குமதி ஆனது',
    openTheGroup: 'குழுவைத் திற',
    importedCount: {
      one: '{n} செலவு இறக்குமதி ஆனது. அது இந்த ஃபோனில் சேமிக்கப்பட்டுள்ளது, இணைப்பு கிடைத்ததும் ஒத்திசைக்கும்.',
      other:
        '{n} செலவுகள் இறக்குமதி ஆயின. அவை இந்த ஃபோனில் சேமிக்கப்பட்டுள்ளன, இணைப்பு கிடைத்ததும் ஒத்திசைக்கும்.',
    },
    expenseCount: { one: '{n} செலவு', other: '{n} செலவுகள்' },
    settlementCount: { one: '{n} தீர்வு', other: '{n} தீர்வுகள்' },
    peopleCount: { one: '{n} நபர்', other: '{n} நபர்கள்' },
    peopleAdded: {
      one: '{n} நபர் சேர்க்கப்பட்டார், கோரப்படக் காத்திருக்கிறார்',
      other: '{n} நபர்கள் சேர்க்கப்பட்டனர், கோரப்படக் காத்திருக்கின்றனர்',
    },
    rowsSkipped: { one: '{n} வரிசை விடப்படும்', other: '{n} வரிசைகள் விடப்படும்' },
    andMore: '…மேலும் {n}.',
    fromBaakiNote:
      'ஒவ்வொரு இருப்பும் காசு வரை சரியாக வரும், தீர்வுகள் உட்பட. வராதவை: ஒவ்வொரு செலவின் திருத்த வரலாறு, மற்றும் பழைய கொடுப்பனவு எந்தச் செலவுகளுக்குப் பயன்படுத்தப்பட்டது என்பது. இரண்டும் யார் என்ன தர வேண்டும் என்பதை மாற்றாது.',
    fromSplitwiseNote:
      'இருப்புகள் அப்படியே வரும். யார் கொடுத்தார்கள் என்பது வராது: Splitwise ஏற்றுமதி ஒரு வரிசையில் ஒவ்வொருவரும் எவ்வளவு மேலே அல்லது கீழே போனார்கள் என்பதை மட்டுமே பதிவு செய்கிறது, பல வேறுபட்ட செலுத்துபவர்கள் ஒரே முடிவைத் தருவார்கள். இறக்குமதி செய்யப்பட்ட ஒவ்வொரு செலவும் குறிக்கப்படும், நீங்கள் எதையும் திருத்தலாம்.',
    otherCurrenciesNote:
      'கீழே உள்ள தொகைகள் {currency} இல் உள்ளவை. {others} உம் வரும், அவை ஒருபோதும் மாற்றப்படுவதில்லை.',
    noGroupsInFile: 'அந்தக் கோப்பில் இறக்குமதி செய்ய குழுக்கள் இல்லை.',
    couldNotFindYou:
      'அந்தக் குழுவில் உங்களைக் கண்டறிய முடியவில்லை. அதைத் திறந்து மீண்டும் முயற்சிக்கவும்.',
  },
  pickers: {
    contactsDenied:
      'பாக்கியால் உங்கள் தொடர்புகளைப் பார்க்க முடியாது. பெயர், மின்னஞ்சல் அல்லது எண்ணைத் தட்டச்சு செய்து இன்னும் நபர்களைச் சேர்க்கலாம் — ஒரு குழுவுக்கு உங்கள் முகவரிப் புத்தகம் தேவையில்லை.',
    openSettings: 'அமைப்புகளைத் திற',
    contactsUnavailable:
      'இந்த ஃபோனில் உள்ள முகவரிப் புத்தகத்தைப் பாக்கியால் படிக்க முடியவில்லை. உங்கள் அனுமதிகளில் எந்தத் தவறும் இல்லை — பெயர், மின்னஞ்சல் அல்லது எண்ணைத் தட்டச்சு செய்து நபர்களைச் சேருங்கள்.',
    tryAgain: 'மீண்டும் முயற்சி',
    searchContacts: 'தொடர்புகளைத் தேடு',
    contactCount: { one: '{n} தொடர்பு', other: '{n} தொடர்புகள்' },
    clearSearch: 'தேடலை அழி',
    nobodyHere: 'இங்கே யாரும் இல்லை',
    noContactMatches: 'அதற்குப் பொருந்தும் தொடர்பு இல்லை.',
    noneHasEmailOrNumber: 'உங்கள் தொடர்புகளில் யாருக்கும் மின்னஞ்சலோ எண்ணோ இல்லை.',
    onlyPickedAreSent:
      'நீங்கள் தேர்ந்தெடுத்த நபர்கள் மட்டுமே பாக்கிக்கு அனுப்பப்படுவார்கள். உங்கள் தொடர்புகள் இந்த ஃபோனிலேயே இருக்கும்.',
    jumpToLetter: 'ஒரு எழுத்துக்குச் செல்',
    country: 'நாடு',
    dialCodeTitle: 'நாட்டுக் குறியீடு',
    searchCountry: 'நாடுகளைத் தேடு',
    settlesWith: '{country} · {rails} மூலம் தீர்க்கும்',
    notSet: 'அமைக்கப்படவில்லை',
    notSetRails: 'வங்கிப் பரிமாற்றம், பணம், Wise மற்றும் Revolut',
    countryNote:
      'இது நீங்கள் ஒருவருக்கொருவர் எப்படிப் பணம் தரலாம் என்பதையும், புதிய செலவு எந்த நாணயத்தில் தொடங்கும் என்பதையும் தீர்மானிக்கிறது. ஏற்கெனவே பதிவானவை மாறாது.',
    starts: 'தொடக்கம்',
    ends: 'முடிவு',
    dailyReminders: 'தினசரி நினைவூட்டல்கள்',
    breakfast: 'காலை உணவு',
    endOfDay: 'நாள் முடிவு',
    clearDates: 'தேதிகளை அழி',
    nobodyPickedYet: 'இன்னும் யாரையும் தேர்ந்தெடுக்கவில்லை',
    personCount: { one: '{n} நபர்', other: '{n} நபர்கள்' },
    alreadyAddedName: '{name}, ஏற்கனவே சேர்க்கப்பட்டது',
    alreadyInGroup: 'ஏற்கனவே இந்தக் குழுவில் உள்ளார்',
    removeName: '{name} ஐ நீக்கு',
    remindZoneNote:
      '{zone} இல் கேட்கப்படுகிறது — பயணம் இருக்கும் இடம், ஒவ்வொருவரும் இருக்கும் இடம் அல்ல.',
    useMyTimezone: 'என் நேர மண்டலத்தைப் பயன்படுத்து ({zone})',
  },
  dispute: {
    yourReply: 'உங்கள் பதில்',
    replyPlaceholder: 'விருப்பம் — உண்மையில் என்ன நடந்தது',
    saving: 'சேமிக்கிறது…',
    theyAreRight: 'அவர்கள் சொல்வது சரி — நான் திருத்துகிறேன்',
    itIsCorrect: 'இது சரியானது',
    answerThis: 'இதற்குப் பதில் சொல்',
    youSaidWrong: 'இது தவறு என்று நீங்கள் சொன்னீர்கள்',
    whatIsWrong: 'இந்தச் செலவில் என்ன தவறு',
    reasonPlaceholder: 'இனிப்புக்கு முன்பே கிளம்பிவிட்டேன் · மொத்தம் ₹1,800',
    reasonOptional:
      'காரணம் விருப்பம்தான், ஆனால் ஒரு திருத்தத்துக்கும் ஒரு உரையாடலுக்கும் இடையிலான வேறுபாடு அதுவே.',
    fixItMyself: 'நானே திருத்துகிறேன்',
  },
  upgradeScreen: {
    moreScans: 'அதிக ரசீது ஸ்கேன்கள்',
    moreScansBody:
      'ஒரு ரசீதைப் புகைப்படம் எடுத்தால் அதன் வரிகள் படிக்கப்படும். ஒவ்வொரு ஸ்கேனுக்கும் உண்மையான செலவு ஆகிறது — அதனால்தான் இதற்கு மட்டும் வரம்பு உள்ளது.',
    biggerTransfers: 'பெரிய ஏற்றுமதிகளும் இறக்குமதிகளும்',
    biggerTransfersBody:
      'உங்கள் தரவு உங்களுடையது, முழுமையாக இலவசமாக வெளியேறும். பெரிய வேலைகளும் திட்டமிட்ட காப்புப் பிரதிகளுமே வசதி.',
    nothingToBuy: 'இன்னும் வாங்க எதுவும் இல்லை',
    nothingToBuyBody:
      'இது கடை அல்ல, கதவு. பணம் தர மதிப்புள்ள ஏதாவது வரும்போது, விலையுடன் இங்கே இருக்கும் — திடீர் ஆச்சரியங்கள் இல்லை.',
    whatWouldCost: 'எப்போதாவது பணம் என்ன செலவாகும்',
    whatNeverWill: 'எதற்கு ஒருபோதும் இல்லை',
    whatNeverWillBody:
      'கணக்கு. குழுக்கள், செலவுகள், பிரிவுகள், இருப்புகள், தீர்த்தல், அனைத்தையும் திரும்பப் பெறுதல் — {free}. பாதி மட்டுமே படிக்கக்கூடிய கணக்கு கணக்கே அல்ல.',
  },
  promo: {
    row: 'குறியீட்டைப் பயன்படுத்து',
    rowHint: 'யாராவது உங்களுக்குக் கொடுத்திருந்தால்',
    title: 'குறியீட்டைப் பயன்படுத்து',
    intro:
      'குறியீடுகள் கையால் வழங்கப்படுகின்றன — உதவிக்காக, நன்றி சொல்ல, அல்லது ஒரு முறை சோதித்துப் பார்க்க.',
    placeholder: 'BAAKI2026',
    redeem: 'பயன்படுத்து',
    granted: 'முடிந்தது',
    grantedBody:
      '{until} வரை Plus இயங்கும். எதுவும் வசூலிக்கப்படவில்லை, தானாகப் புதுப்பிக்கவும் ஆகாது.',
    unknownCode: 'அப்படி ஒரு குறியீடு இல்லை. எழுத்துகளையும் எண்களையும் சரிபாருங்கள்.',
    expired: 'அந்தக் குறியீட்டின் காலம் முடிந்துவிட்டது.',
    exhausted: 'அனுமதிக்கப்பட்ட அளவுக்கு அந்தக் குறியீடு ஏற்கனவே பயன்படுத்தப்பட்டுவிட்டது.',
    alreadyRedeemed: 'அதை நீங்கள் ஏற்கனவே பயன்படுத்திவிட்டீர்கள்.',
    couldNotRedeem: 'இப்போது குறியீட்டைச் சரிபார்க்க முடியவில்லை. சிறிது நேரம் கழித்து முயலுங்கள்.',
  },
  claims: {
    askToJoinAs: '{name} ஆக சேர அனுமதி கேளுங்கள்',
    needsConfirming: 'குழுவின் நிர்வாகி உறுதி செய்த பிறகே எதுவும் மாறும்.',
    waitingTitle: 'கேட்கப்பட்டது',
    waitingBody:
      'நீங்கள் {name} தானா என்பதை {group} நடத்துபவர் உறுதி செய்ய வேண்டும். பதில் எப்படியிருந்தாலும் உங்களுக்குத் தெரிவிக்கப்படும் — குழுவில் இன்னும் எதுவும் மாறவில்லை.',
    joinAsNewInstead: 'புதிய நபராகச் சேருங்கள்',
    requestsTitle: 'சேர காத்திருப்பவர்கள்',
    saysTheyAre: 'தான் {name} என்கிறார் {who}',
    approve: 'உறுதி செய்',
    decline: 'இவர் அல்ல',
    decideFailed: 'இப்போது பதிலளிக்க முடியவில்லை. சிறிது நேரம் கழித்து முயலுங்கள்.',
    alreadyDecided: 'இதற்கு ஏற்கனவே ஒருவர் பதிலளித்துவிட்டார்.',
    placeTaken: 'அந்த இடம் இப்போது வேறு ஒருவருக்கு உரியது.',
    theyAreAlreadyIn: 'அவர் ஏற்கனவே இந்தக் குழுவில் இருக்கிறார்.',
  },
  privacy: {
    row: 'தனியுரிமை & பாதுகாப்பு',
    rowHint: 'என்ன சேமிக்கப்படுகிறது, எப்படி பாதுகாக்கப்படுகிறது',
    title: 'தனியுரிமை & பாதுகாப்பு',
    intro:
      'பாக்கி வேலை செய்ய எவ்வளவு தேவையோ அவ்வளவு மட்டுமே உங்களைப் பற்றி வைத்திருக்கிறது. அது என்ன என்பது இங்கே.',
    storeTitle: 'என்ன சேமிக்கப்படுகிறது',
    storeBody:
      'உங்கள் பெயர், நீங்கள் பயன்படுத்திய தொலைபேசி எண், மின்னஞ்சல் அல்லது உள்நுழைவு அடையாளம். விருப்பப்படி ஒரு பணப் பரிமாற்ற முகவரி, மற்றும் ஒரு நாடு. நீங்கள் இருக்கும் குழுக்கள், அவற்றின் செலவுகள், யார் யாருக்குக் கடன்பட்டவர். வேறு எதுவும் இல்லை: தொடர்புகள் பதிவேற்றப்படுவதில்லை, விளம்பர அடையாளம் இல்லை.',
    protectTitle: 'எப்படி பாதுகாக்கப்படுகிறது',
    protectBody:
      'ஒவ்வொரு அட்டவணையும் தரவுத்தளத்தில் வரிசை-நிலை பாதுகாப்பின் பின்னால் உள்ளது — செயலி வடிகட்டுவதல்ல, தரவுத்தளமே அமல்படுத்தும் விதி. ரசீது படங்கள் தனிப்பட்ட இடத்தில், குறுகிய கால இணைப்புகள் வழியாக மட்டுமே. செயலி முறிவு அறிக்கைகளிலிருந்து முகவரிகள், எண்கள், பணமுகவரிகள் தொலைபேசியை விட்டு வெளியேறும் முன்பே நீக்கப்படுகின்றன.',
    choicesTitle: 'நீங்கள் என்ன செய்யலாம்',
    choicesBody:
      'நீங்கள் உள்ளிட்ட அனைத்தையும் எப்போது வேண்டுமானாலும், முழுமையாக, இலவசமாக ஏற்றுமதி செய்யலாம். எந்த அறிவிப்பையும் நிறுத்தலாம். உங்கள் கணக்கையும் அதிலுள்ள தனிப்பட்ட தரவையும் நீக்கலாம்.',
    englishGoverns:
      'இந்த உரை வசதிக்காக மொழிபெயர்க்கப்பட்டுள்ளது. மொழிபெயர்ப்புக்கும் ஆங்கிலத்துக்கும் வேறுபாடு இருந்தால், ஆங்கிலமே செல்லுபடியாகும்.',
    couldNotSave: 'இது சேமிக்கப்படவில்லை. சிறிது நேரம் கழித்து முயற்சிக்கவும்.',
    analyticsTitle: 'செயலி எப்படி பயன்படுத்தப்படுகிறது',
    analyticsBody:
      'எந்தத் திரையில் சிக்கல் வருகிறது என்பதைப் புரிந்துகொள்ள Microsoft Clarity மூலம் பயன்பாட்டைப் பதிவு செய்ய முடியும். இது இயல்பாக அணைக்கப்பட்டே வருகிறது; இயக்கப்படாத வரை எதுவும் பதிவாகாது. விளம்பரத்திற்கு ஒருபோதும் பயன்படுத்தப்படுவதில்லை, விளம்பர அடையாளம் இல்லை, எதுவும் விற்கப்படுவதில்லை.',
    sessionReplayRow: 'நான் செயலியைப் பயன்படுத்தும் விதத்தைப் பதிவு செய்',
    previewGroups: {
      one: 'நீங்கள் {n} குழுவில் உள்ளீர்கள்.',
      other: 'நீங்கள் {n} குழுக்களில் உள்ளீர்கள்.',
    },
    previewExpenses: {
      one: 'நீங்கள் சேர்த்த {n} செலவு இருக்கும்.',
      other: 'நீங்கள் சேர்த்த {n} செலவுகள் இருக்கும்.',
    },
    previewSettlements: {
      one: '{n} தீர்வில் உங்கள் பெயர் உள்ளது.',
      other: '{n} தீர்வுகளில் உங்கள் பெயர் உள்ளது.',
    },
    previewOutstanding: '{list} இல் இன்னும் தீராத நிலுவை உள்ளது.',
    feedbackRow: 'கருத்து அனுப்பு',
    feedbackRowHint: 'என்ன தவறு, அல்லது என்ன இல்லை என்று சொல்லுங்கள்',
    feedbackTitle: 'கருத்து அனுப்பு',
    feedbackHint:
      'ஒரு நபரால் படிக்கப்படும். எவ்வளவு வேண்டுமானாலும் எழுதலாம் — குறிப்பிட்டதாக இருந்தால் அதிகம் உதவும்.',
    feedbackPlaceholder: 'என்ன நடந்தது, அல்லது என்ன இருக்க வேண்டும் என நினைக்கிறீர்கள்',
    feedbackSend: 'அனுப்பு',
    feedbackThanks: 'நன்றி — கிடைத்துவிட்டது.',
    kindGeneral: 'பொது',
    kindBug: 'ஏதோ வேலை செய்யவில்லை',
    kindIdea: 'ஒரு யோசனை',
    deleteRow: 'என் தரவை நீக்கு',
    deleteRowHint: 'உங்கள் கணக்கையும் தனிப்பட்ட விவரங்களையும் நீக்கு',
    deleteTitle: 'என் தரவை நீக்கு',
    deleteIntro:
      'இதை மீட்டெடுக்க முடியாது. என்ன நீக்கப்படும், என்ன நீக்கப்படாது என்பதைப் படியுங்கள் — இரண்டாவது பகுதிதான் பலரை ஆச்சரியப்படுத்துகிறது.',
    deleteGoesTitle: 'என்ன நீக்கப்படும்',
    deleteGoesBody:
      'உங்கள் பெயர், படம், பணமுகவரி, நாடு, மொழி, அறிவிப்பு அமைப்புகள். உங்கள் உள்நுழைவு — இந்தக் கணக்கை இனி திறக்க முடியாது. உங்கள் சாதனங்கள், அறிவிப்பு வரலாறு, கொள்முதல்கள்.',
    deleteStaysTitle: 'என்ன இருக்கும், ஏன்',
    deleteStaysBody:
      'உங்கள் குழுக்களில் உள்ள செலவுகளும் தீர்வுகளும் இருக்கும், ஏனெனில் அவை மற்றவர்களின் பதிவுகளும் கூட — யார் யாருக்குக் கடன்பட்டவர் என்பதைச் சொல்வது அவைதான். அவற்றை நீக்கினால் யாரும் கட்டாத கடன் தானாகத் தீர்ந்துவிடும். நீங்கள் பெயரில்லாத முன்னாள் உறுப்பினராகிவிடுவீர்கள்.',
    deleteExportFirst: 'முதலில் உங்கள் தரவை ஏற்றுமதி செய்யுங்கள்',
    deleteWhyLabel: 'ஏன் விலகுகிறீர்கள்? (விருப்பம்)',
    deleteWhyPlaceholder: 'தெரிந்தால் உதவும்; கணக்கு போன பிறகும் இது வைக்கப்படும்',
    deleteConfirmLabel: 'உறுதிப்படுத்த DELETE என தட்டச்சு செய்யுங்கள்',
    deleteConfirmWord: 'DELETE',
    deleteButton: 'என் தரவை நீக்கு',
    deleteWorking: 'நீக்கப்படுகிறது…',
    deleteDone: 'உங்கள் தரவு நீக்கப்பட்டது.',
    deleteSummary: {
      one: 'நீங்கள் இப்போது {n} குழுவின் முன்னாள் உறுப்பினர்.',
      other: 'நீங்கள் இப்போது {n} குழுக்களின் முன்னாள் உறுப்பினர்.',
    },
  },
  extras: {
    blankNameHint: 'காலியாக விட்டால், குழுவில் உள்ளவர்களின் பெயரில் குழு அமையும்.',
    whatKindOfGroup: 'என்ன வகைக் குழு?',
    typeTrip: 'பயணம்',
    typeHome: 'வீடு',
    typeCouple: 'தம்பதி',
    typeEvent: 'நிகழ்வு',
    typeOther: 'மற்றவை',
    addPeopleByName: 'நண்பர்களைச் சேர்',
    ghostNote:
      'அவர்களுக்குச் செயலி தேவையில்லை. இப்போதே சேருங்கள், பிறகு அவர்கள் தங்கள் வரலாற்றைக் கோரலாம்.',
    claimHistoryNote:
      'உங்கள் பெயரைத் தேர்ந்தெடுத்தால், உங்களுக்காக ஏற்கெனவே பதிவானது எல்லாம் உங்களுடன் வரும்.',
    theirPastBecomesYours: 'அவர்களின் பழைய செலவுகளும் இருப்புகளும் உங்களுடையவை ஆகும்.',
    guestKeepsItHere:
      'விருந்தினராகச் சேர்ந்தால் எல்லாம் இந்தச் சாதனத்திலேயே இருக்கும். பிறகு ஒரு ஃபோன் எண்ணைச் சேர்த்தால், எல்லாம் வேறு ஃபோனுக்கும் உங்களைப் பின்தொடரும்.',
    lockedTitle: 'பாக்கி பூட்டப்பட்டுள்ளது',
    lockedBody: 'இந்த ஃபோனைத் திறக்கும் அதே முகம் அல்லது கைரேகையால் திறக்கவும்.',
    unlock: 'திற',
    paidIn: 'இதில் செலுத்தப்பட்டது',
    iKnowTheRate: 'எனக்கு விகிதம் தெரியும்',
    notAnAmountShort: 'தொகை அல்ல',
    oneChangeFailed: 'ஒரு மாற்றத்தைச் சேமிக்க முடியவில்லை',
    tryAgain: 'மீண்டும் முயற்சி',
    discardIt: 'அதை விட்டுவிடு',
    needsUpdating: 'பாக்கியைப் புதுப்பிக்க வேண்டும்',
    nothingIsLost:
      'எதுவும் இழக்கப்படவில்லை. ஒவ்வொரு குழுவும், செலவும், தீர்வும் சேவையகத்தில் உள்ளன, நீங்கள் விட்ட இடத்திலேயே இருக்கும்.',
    worthAMinute: 'நேரம் கிடைக்கும்போது ஒரு நிமிடம் மதிப்புள்ளது.',
    theGroup: 'குழு',
    noGroupsYet:
      'உங்களுக்கு இன்னும் குழுக்கள் இல்லை. பாக்கியில் ஒரு நபர் ஒரு குழுவுக்கு உரியவர், ஏனெனில் ஒரு கடன் எப்போதும் எதையாவது பற்றியது — ஒரு பயணம், ஒரு வீடு, ஒரு இரவு உணவு.',
    ghostShareNote:
      'அவர்களுக்குச் செயலி தேவையில்லை. அவர்களின் பங்கு அவர்கள் பெயரில் பதிவாகும், பிறகு இதே மின்னஞ்சல் அல்லது எண்ணுடன் சேர்ந்தால் ஏற்கெனவே அங்கே உள்ள அனைத்தையும் கோரலாம்.',
    justMe: 'நான் மட்டும்',
    yourShareNote: 'நான் மட்டும் — ஒவ்வொரு தொகையும் உங்கள் பங்கு, முழுச் செலவு அல்ல.',
    sms: 'SMS',
    email: 'மின்னஞ்சல்',
    paymentWentThrough: 'கொடுப்பனவு சென்றதா?',
    onlyIfCompleted: 'உண்மையிலேயே முடிந்திருந்தால் மட்டும் பதிவு செய்யுங்கள்.',
    restAppliesOverall: 'மீதி மொத்த இருப்புக்குப் பயன்படும், பழைய செலவு முதலில்.',
    couldNotReadImage: 'அந்தப் படத்தைப் படிக்க முடியவில்லை.',
    deliveryComesLater:
      'புஷ் மற்றும் மின்னஞ்சல் வழங்கல் M4 உடன் வரும். அதுவரை எல்லாம் இங்கேயே வந்து சேரும்.',
    perCurrencyNote:
      'தொகைகள் ஒவ்வொரு நாணயத்திற்கும் தனித்தனியாக வைக்கப்படும், ஒரே மொத்தமாக மாற்றப்படுவதில்லை. கணக்கு இல்லாதவர்கள் ஒவ்வொரு குழுவிலும் தனியாகக் கணக்கிடப்படுவார்கள், ஏனெனில் இரண்டு பேருக்கு ஒரே பெயர் இருக்கலாம்.',
    savedStraightAway:
      'சிக்னல் இருந்தாலும் இல்லாவிட்டாலும் உடனே இந்த ஃபோனில் சேமிக்கப்படும். சேமிக்கும் முன் ஒவ்வொரு பங்கையும் சேவையகம் மீண்டும் கணக்கிடுகிறது, எனவே எந்தச் சாதனமும் தவறான எண்ணைக் கணக்கில் தள்ள முடியாது.',
    nothingOverwritten:
      'இங்கே எதுவும் மேலெழுதப்படுவதில்லை. மேலே உள்ள ஒவ்வொரு பதிப்பும் வைக்கப்படுகிறது, நீக்கப்பட்ட செலவை 30 நாட்களுக்கு மீட்கலாம்.',
  },
  errorBoundary: {
    title: 'ஏதோ தவறாகிவிட்டது',
    body: 'அந்தத் திரையில் பிழை ஏற்பட்டது. நீங்கள் சேமித்தது எதுவும் இழக்கப்படவில்லை — திரும்பிச் சென்று மீண்டும் முயலுங்கள்.',
    action: 'முகப்புக்குத் திரும்பு',
  },
};

const hi: UiStrings = {
  greeting: 'नमस्ते',
  yourBaaki: 'आपकी बाकी',
  acrossGroups: { one: '{n} समूह में', other: '{n} समूहों में' },
  youAreOwed: 'आपको मिलने हैं',
  youOwe: 'आपको देने हैं',
  allSettled: 'सब बराबर',
  yourGroups: 'आपके समूह',
  filterAll: 'सभी',
  newGroup: 'नया समूह',
  activity: 'गतिविधि',
  friends: 'दोस्त',
  sort: { by: 'क्रमबद्ध करें', amount: 'राशि', date: 'हाल की गतिविधि', name: 'नाम' },
  addPerson: {
    title: 'एक व्यक्ति जोड़ें',
    subtitle: 'किसी को आप पर कितना देना है, यह रखें — न उन्हें ऐप चाहिए, न कोई समूह बनाना है।',
    nameLabel: 'उनका नाम',
    namePlaceholder: 'जैसे रवि',
    amountLabel: 'राशि',
    directionQuestion: 'किस ओर?',
    theyOweMe: 'वे मुझे देंगे',
    iOweThem: 'मैं उन्हें दूँगा',
    noteLabel: 'नोट (वैकल्पिक)',
    notePlaceholder: 'किस लिए?',
    save: 'दर्ज करें',
    couldNotRecord: 'यह दर्ज नहीं हो सका। कृपया फिर कोशिश करें।',
  },
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
  payViaRail: '{rail} से भुगतान करें',
  youPayName: 'आप {name} को भुगतान करते हैं',
  namePaysYou: '{name} आपको भुगतान करते हैं',
  settleConfirmYouPay: '{name} से पुष्टि माँगी जाएगी। Baaki के ज़रिए पैसा हाथ नहीं बदलता।',
  settleConfirmTheyPay: 'जब वे इसे चुकाया हुआ चिह्नित करेंगे, तब आपसे पुष्टि माँगी जाएगी।',
  members: 'सदस्य',
  memberCount: { one: '{n} सदस्य', other: '{n} सदस्य' },
  notJoinedYet: 'अभी शामिल नहीं हुए',
  scansLeft: 'स्कैन बाकी',
  simplifyOn: 'आसान करना चालू',
  simplifyOff: 'आसान करना बंद',
  simplifySuggestBody:
    'Baaki सबसे कम भुगतानों का सुझाव देता है जो समूह का हिसाब चुका दें। नीचे का असली कौन-किसका-देनदार हिसाब कभी नहीं बदला जाता।',
  simplifyPairwiseBody: 'खर्चों ने जैसा बनाया, ठीक वैसा असली जोड़ीवार हिसाब दिखाया जा रहा है।',
  simplifyPaymentsCount: { one: '{n} भुगतान', other: '{n} भुगतान' },
  simplifyPaysWhom: '{from} {to} को भुगतान करते हैं',
  simplifyYouPay: 'आप भुगतान करते हैं',
  simplifyYouReceive: 'आपको मिलते हैं',
  freeForever: 'हमेशा मुफ़्त',
  nothingYet: 'यहाँ अभी कुछ नहीं है',
  nothingYetBody: 'पहला खर्च जोड़िए, हिसाब अपने आप संभल जाएगा।',
  loadError: 'यह लोड नहीं हो सका',
  loadErrorBody: 'कनेक्शन जाँचें और खींचकर रिफ़्रेश करें, या फिर कोशिश करें।',
  retry: 'फिर कोशिश करें',
  whatFor: 'किस तरह का खर्च',
  spending: 'खर्च',
  byCategory: 'कहाँ गया',
  byMonth: 'महीने के हिसाब से',
  totalIn: '{currency} में कुल',
  nothingIn: '{currency} में कुछ नहीं',
  tapMonthForDays: 'दिन देखने के लिए महीने पर टैप करें।',
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
  dayNumber: 'दिन {n}',
  tripDay: 'दिन {day}/{total}',
  planned: 'तय किया',
  spent: 'खर्च हुआ',
  overBudget: 'ज़्यादा',
  underBudget: 'कम',
  budgets: 'बजट',
  overallBudget: 'कुल',
  myBudget: 'मेरा बजट',
  budgetAmount: 'राशि',
  shareWithGroup: 'ग्रुप के साथ साझा करें',
  budgetPrivate: 'सिर्फ़ मैं',
  saveBudget: 'सेव',
  clearBudget: 'हटाएँ',
  budgetLeft: 'बचा',
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
    loading: 'लोड हो रहा है…',
    close: 'बंद करें',
    cancel: 'रद्द करें',
    save: 'सेव करें',
    edit: 'बदलें',
    remove: 'हटाएँ',
    delete: 'मिटाएँ',
    share: 'साझा करें',
    done: 'हो गया',
    about: '{title} के बारे में',
    guest: 'मेहमान',
    name: 'नाम',
    yourName: 'आपका नाम',
    emailOrPhone: 'ईमेल या फ़ोन नंबर',
    notFound: 'नहीं मिला',
    goBack: 'वापस जाएँ',
    ok: 'ठीक है',
    tooFastMoment: 'एक साथ बहुत ज़्यादा। थोड़ा रुककर फिर कोशिश करें।',
    tooFastLater: 'एक साथ बहुत ज़्यादा। कुछ देर बाद फिर कोशिश करें।',
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
  theme: {
    title: 'रूप-रंग',
    light: 'हल्का',
    dark: 'गहरा',
    lightHint: 'हल्का लैवेंडर पर्दा।',
    darkHint: 'रात में आँखों के लिए आसान।',
    currently: 'अभी {scheme}',
    followingPhone: 'आपके फ़ोन के अनुसार',
    footnote: 'फ़ोन के अनुसार रखने पर, फ़ोन गहरा होने पर ऐप भी गहरा हो जाता है।',
  },
  sync: {
    title: 'किस पर सिंक करें',
    wifi: 'केवल वाई‑फ़ाई',
    wifiHint: 'केवल वाई‑फ़ाई पर सिंक करें। मोबाइल डेटा कभी खर्च नहीं होगा।',
    cellular: 'केवल मोबाइल डेटा',
    cellularHint: 'केवल मोबाइल डेटा पर सिंक करें, वाई‑फ़ाई पर नहीं।',
    both: 'वाई‑फ़ाई और मोबाइल डेटा',
    bothHint: 'जो भी कनेक्शन उपलब्ध हो, उस पर सिंक करें।',
    footnote:
      'बदलाव हमेशा आपके फ़ोन पर सहेजे जाते हैं। यह केवल तय करता है कि वे कब फ़ोन से बाहर जाएँ।',
    selected: 'चुना गया',
    waitingWifi: 'सहेजा गया — सिंक के लिए वाई‑फ़ाई की प्रतीक्षा है।',
    waitingCellular: 'सहेजा गया — सिंक के लिए मोबाइल डेटा की प्रतीक्षा है।',
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
  devices: {
    title: 'डिवाइस',
    intro:
      'मुफ़्त प्लान में एक साथ दो डिवाइस चलते हैं। जो डिवाइस कुछ समय से नहीं खुला, वह अपने आप गिनती से हट जाता है।',
    thisDevice: 'यह डिवाइस',
    signedOut: 'साइन आउट',
    lastActive: 'आख़िरी बार सक्रिय {when}',
    signOutOthers: 'बाकी सभी डिवाइस से साइन आउट करें',
    signOutOthersHint:
      'इस डिवाइस को छोड़कर हर डिवाइस से साइन आउट कर देता है। अगली बार उन पर लॉगिन माँगा जाएगा।',
    signedOutOthers: {
      one: '{n} अन्य डिवाइस से साइन आउट किया।',
      other: '{n} अन्य डिवाइसों से साइन आउट किया।',
    },
    onlyThisDevice: 'सिर्फ़ यही डिवाइस साइन इन है।',
    historyNote: 'पिछले तीन महीने दिखाए जा रहे हैं।',
    row: 'डिवाइस',
    rowHint: 'देखें कि आप कहाँ-कहाँ साइन इन हैं',
    gateTitle: 'बहुत ज़्यादा डिवाइस पर साइन इन',
    gateBody:
      'मुफ़्त प्लान में एक साथ दो डिवाइस चलते हैं, और यह अकाउंट उससे ऊपर है। इस डिवाइस पर बाकी इस्तेमाल करते रहने के लिए बाकियों से साइन आउट करें।',
    gateAction: 'दूसरे डिवाइस से साइन आउट करें',
    gateDismiss: 'अभी नहीं',
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
    sectionProfile: 'प्रोफ़ाइल',
    sectionBaaki: 'बाकी',
    sectionSettings: 'सेटिंग्स',
    sectionSecurity: 'सुरक्षा',
    youRowHint: 'आपका नाम और आप कैसे दिखते हैं',
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
    themeRow: 'रूप-रंग',
    languageFollowingPhone: 'आपके फ़ोन के अनुसार — {language}',
    languageRestartHint: '{language} · दिशा बदलने के लिए बाकी दोबारा खोलें',
    languageRestartHintBack: '{language} · दिशा वापस लाने के लिए बाकी दोबारा खोलें',
    restartTitle: 'बाकी को बंद करके दोबारा खोलें',
    restartNow: 'बाकी दोबारा शुरू करें',
    restartNowMirror: 'दिशा बदलने के लिए बाकी अभी दोबारा शुरू करें?',
    restartNowUnmirror: 'दिशा वापस लाने के लिए बाकी अभी दोबारा शुरू करें?',
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
    emailSection: 'ईमेल से',
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
    phonePlaceholder: '{code} 98765 43210',
    codeEmailed: 'ईमेल पर भेजा गया छह अंकों का कोड डालें',
    codeTexted: 'मैसेज पर भेजा गया छह अंकों का कोड डालें',
    verificationCode: 'सत्यापन कोड',
    confirm: 'पुष्टि करें',
    sendCodeEmail: 'मुझे कोड भेजें',
    sendCodePhone: 'मैसेज पर कोड भेजें',
    useDifferent: 'कोई दूसरा इस्तेमाल करें',
    added: 'जुड़ गया। अब आप इससे किसी दूसरे फ़ोन पर साइन इन कर सकते हैं।',
    signInMethodsTitle: 'साइन इन करने के तरीके',
    signInMethodsBody: 'कोई खाता लिंक करें और अगली बार किसी भी फ़ोन पर उससे साइन इन कर सकते हैं।',
    link: 'लिंक करें',
    linked: 'लिंक किया गया',
    footnote:
      'अंदर आने देने के लिए बाकी यह कभी नहीं माँगता, और आपके समूह में किसी के साथ इसे साझा नहीं करता। लोग सिर्फ़ वही नाम देखते हैं जो आप चुनते हैं।',
    gateTitle: 'जारी रखने के लिए अपना खाता रखें',
    gateGroupBody:
      'आप बतौर मेहमान एक समूह में हैं। और समूह शुरू करने या उनमें शामिल होने के लिए ईमेल, फ़ोन या प्रोवाइडर जोड़ें — आपका जोड़ा हुआ सब कुछ आपके साथ रहेगा।',
    gateExpiredBody:
      'आपकी मेहमान अवधि खत्म हो गई है, इसलिए अभी ऐप सिर्फ़ पढ़ने के लिए है। जोड़ते रहने के लिए साइन इन का कोई तरीका जोड़ें — आपके समूह और खर्च सब यहीं मौजूद हैं।',
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
    useAPassword: 'ईमेल या पासवर्ड',
    phoneNumber: 'फ़ोन नंबर',
    countryCodeHint:
      'देश कोड से शुरू करें। बाकी +91 कभी नहीं मान लेता — विदेशी नंबर सफ़र में ही तो आते हैं।',
    sendCode: 'कोड भेजें',
    codeSentTo: '{value} पर कोड भेजा गया',
    verify: 'सत्यापित करें',
    differentNumber: 'कोई दूसरा नंबर इस्तेमाल करें',
    identifier: 'ईमेल या फ़ोन नंबर',
    identifierPlaceholder: 'alex@example.com या {code}…',
    password: 'पासवर्ड',
    passwordHint: 'आठ या ज़्यादा अक्षर। याद रहने वाला वाक्यांश, न याद रहने वाली पहेली से बेहतर है।',
    addToAccount: 'इसे मेरे खाते में जोड़ें',
    createAccount: 'खाता बनाएँ',
    signInAction: 'साइन इन',
    switchToSignIn: 'पहले से खाता है? साइन इन करें',
    switchToSignUp: 'नए हैं? खाता बनाएँ',
    continueGoogle: 'Google से जारी रखें',
    signInGoogle: 'Google से साइन इन करें',
    continueApple: 'Apple से जारी रखें',
    signInApple: 'Apple से साइन इन करें',
    orSignInWith: 'या इसके ज़रिए साइन इन करें',
    continueGuest: 'मेहमान के तौर पर जारी रखें',
    guestFootnote:
      'आपने जो जोड़ा है वह जहाँ है वहीं रहेगा। इससे सिर्फ़ दोबारा साइन इन करने का रास्ता जुड़ता है।',
    memberFootnote:
      'जब तक आप साइन इन का कोई तरीका न जोड़ें, मेहमान खाता सब कुछ इसी डिवाइस पर रखता है। आपका हिसाब कभी बंधक नहीं बनाया जाता।',
    couldNotSignIn: 'साइन इन नहीं हो सका। फिर से कोशिश करें।',
    restartToMirror: 'लेआउट की दिशा बदलने के लिए बाकी को एक बार बंद करके खोलें।',
    restartToUnmirror: 'लेआउट वापस पलटने के लिए बाकी को एक बार बंद करके खोलें।',
  },
  tabs: {
    guestBanner: 'आप बाकी को मेहमान के तौर पर इस्तेमाल कर रहे हैं',
    guestBannerBody:
      'कुछ छूट नहीं रहा — आप जो भी डालते हैं वह सेव है और आपका है। जब भी किसी दूसरे फ़ोन से पहुँचना हो, ईमेल या फ़ोन नंबर जोड़ लें।',
    guestDaysLeft: 'मेहमान के तौर पर {days} दिन बाकी — उसके बाद जारी रखने के लिए साइन अप करें।',
    guestReadOnly:
      'आपकी मेहमान अवधि खत्म हो गई — ऐप सिर्फ़ पढ़ने के लिए है। जोड़ते रहने के लिए साइन अप करें।',
    addYourDetails: 'अपनी जानकारी जोड़ें',
    loadingGroups: 'आपके समूह आ रहे हैं…',
    noGroups: 'अभी कोई समूह नहीं',
    noGroupsBody:
      'किसी सफ़र, फ़्लैट, या बस आप दोनों के लिए एक शुरू करें। खर्च जोड़ना हमेशा मुफ़्त और असीमित है।',
    activityEmptyBody: 'हर खर्च, बदलाव, हटाना और निपटान यहीं आता है — समूह के हर व्यक्ति के लिए।',
    quickActions: 'त्वरित क्रियाएँ',
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
  dashHero: {
    scanTitle: 'रसीद स्कैन करें',
    scanBody: 'बिल स्कैन करें और आइटम अपने आप भर जाते हैं — कुछ ही पलों में बाँटें.',
    scanCta: 'स्कैन',
    inviteTitle: 'मिलकर हिसाब बराबर करें',
    inviteBody: 'जिनके साथ खर्च बाँटते हैं उन्हें जोड़ें और सबका हिसाब बराबर रखें.',
    inviteCta: 'व्यक्ति जोड़ें',
  },
  mergePeople: {
    entry: 'लोगों को मर्ज करें',
    title: 'लोगों को मर्ज करें',
    subtitle:
      'उन मेहमानों को चुनें जो एक ही व्यक्ति हैं। उनके बैलेंस एक नाम के तहत जोड़ दिए जाएँगे.',
    empty:
      'मर्ज करने के लिए कोई मेहमान नहीं — केवल बिना Baaki खाते वाले लोग ही मर्ज किए जा सकते हैं.',
    nameLabel: 'मर्ज किए गए व्यक्ति का नाम',
    namePlaceholder: 'जैसे रवि',
    warningTitle: 'इसे पहले जैसा नहीं किया जा सकता',
    warningBody:
      'उनके अलग-अलग बैलेंस हमेशा के लिए एक व्यक्ति में जोड़ दिए जाते हैं। इन्हें वापस अलग करने का कोई तरीका नहीं है.',
    cta: 'मर्ज करें',
    selected: { one: '{n} व्यक्ति चुना गया', other: '{n} लोग चुने गए' },
    merged: '{name} में मर्ज किया गया',
    errorTooFew: 'मर्ज करने के लिए कम से कम दो लोग चुनें.',
    errorNotMergeable:
      'आप केवल उन मेहमानों को मर्ज कर सकते हैं जिनके साथ आप कोई समूह साझा करते हैं.',
    errorNameRequired: 'मर्ज किए गए व्यक्ति को एक नाम दें.',
    errorGeneric: 'मर्ज नहीं हो सका. कृपया फिर से प्रयास करें.',
  },
  groupPhoto: {
    paidHint: 'ग्रुप फ़ोटो एक Plus सुविधा है। कोई आइकन चुनें, या फ़ोटो जोड़ने के लिए अपग्रेड करें।',
  },
  inbox: {
    title: 'इनबॉक्स',
    nothingYetBody:
      'याद दिलाना, निपटान की पुष्टि और बाकी जो कुछ भी आपसे कहता है, सब यहाँ जमा होता है — भले ही सूचना आपके फ़ोन तक कभी न पहुँची हो।',
    recent: 'हाल के',
  },
  captures: {
    title: 'त्वरित प्रविष्टियाँ',
    captureCta: 'एक खर्च दर्ज करें',
    newTitle: 'एक खर्च दर्ज करें',
    emptyTitle: 'अभी तक कुछ दर्ज नहीं हुआ',
    emptyBody:
      'खर्च होते ही उसे पकड़ लें — रकम, एक नोट, बिल की तस्वीर — और बाद में तय करें कि यह किस समूह का है।',
    amount: 'रकम',
    description: 'यह क्या था?',
    descriptionPlaceholder: 'कॉफ़ी, टैक्सी, राशन…',
    category: 'किसलिए?',
    date: 'तारीख़',
    receipt: 'रसीद',
    addReceipt: 'रसीद जोड़ें',
    reading: 'पढ़ रहे हैं…',
    notSynced: 'अभी सिंक नहीं हुआ',
    assign: 'समूह को सौंपें',
    assignTitle: 'किसी समूह को सौंपें',
    assignBody: 'चुनें कि यह किस समूह का है। किसने चुकाया और कैसे बँटेगा, यह आगे तय कर सकते हैं।',
    noGroups: 'आपके पास अभी कोई समूह नहीं है। पहले एक बनाएँ, फिर इसे उसमें सौंपें।',
    delete: 'हटाएँ',
    deleteConfirm: 'यह कैप्चर हटाएँ? राशि और बिल की फ़ोटो भी चली जाएगी।',
    unassigned: 'असौंपे',
    unassignedBody: {
      one: 'समूह की प्रतीक्षा में {n} प्रविष्टि',
      other: 'समूह की प्रतीक्षा में {n} प्रविष्टियाँ',
    },
    itemizedTitle: 'मदवार',
    itemCount: {
      one: '{n} वस्तु',
      other: '{n} वस्तुएँ',
    },
    couldNotRead: 'यह रसीद पढ़ी नहीं जा सकी — राशि स्वयं दर्ज करें।',
    savedOnDevice: 'इस डिवाइस पर सहेजा गया',
    save: 'सहेजें',
  },
  backup: {
    title: 'रसीद बैकअप',
    subtitle: 'स्कैन की गई रसीदें अपने क्लाउड पर रखें',
    primaryTitle: 'रसीदें यहाँ बैकअप करें',
    primaryBody:
      'स्कैन की गई रसीदें इस डिवाइस पर सहेजी जाती हैं और आपके चुने हुए क्लाउड पर कॉपी होती हैं। वे Baaki के सर्वर पर कभी नहीं जातीं।',
    off: 'बंद',
    connect: 'कनेक्ट करें',
    disconnect: 'डिसकनेक्ट करें',
    connected: 'कनेक्टेड',
    notConfigured: 'इस बिल्ड में सेट नहीं है',
    networkTitle: 'इसके ज़रिए अपलोड करें',
    wifiOnly: 'केवल वाई‑फाई',
    wifiAndData: 'वाई‑फाई और मोबाइल डेटा',
    pending: {
      one: '{n} रसीद बैकअप के लिए प्रतीक्षारत',
      other: '{n} रसीदें बैकअप के लिए प्रतीक्षारत',
    },
    allBackedUp: 'सभी रसीदें बैकअप हो गईं',
    privacyNote:
      'फ़ोटो आपके फ़ोन और आपके चुने हुए क्लाउड पर रहती है। Baaki केवल वह राशि देखता है जो आप सहेजते हैं।',
  },
  group: {
    notFound: 'समूह नहीं मिला',
    notFoundBody: 'हो सकता है यह संग्रहित कर दिया गया हो, या आप अब सदस्य न हों।',
    notFoundArchived: 'हो सकता है यह संग्रहित कर दिया गया हो।',
    loading: 'आ रहा है…',
    settings: 'समूह सेटिंग्स',
    more: 'और',
    mismatch: 'बाकी को ताज़ा करना होगा',
    mismatchBody:
      'इस समूह के हिसाब पर यह डिवाइस और सर्वर सहमत नहीं हैं। खींचकर ताज़ा करें; फिर भी बना रहे तो नीचे का हिसाब ही सही है।',
    confirmReceived: 'मिलने की पुष्टि करें',
    saysTheyPaidYou: '{name} कहते हैं कि उन्होंने आपको भुगतान किया',
    autoConfirms: 'कोई जवाब न दे तो 7 दिन में अपने आप पुष्ट हो जाएगा।',
    hideDeleted: 'हटाए हुए छिपाएँ',
    showDeleted: 'हटाए हुए दिखाएँ',
    activityEmptyBody: 'यहाँ जो कुछ होगा वह इसी फ़ीड में दिखेगा।',
    photoUpdated: 'फ़ोटो बदल गई',
    nameOptional: 'नाम (वैकल्पिक)',
    groupName: 'समूह का नाम',
    saveName: 'नाम सेव करें',
    chooseIcon: 'आइकन चुनें',
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
    archivedTitle: 'संग्रहित समूह',
    archivedEmpty: 'कुछ भी संग्रहित नहीं',
    archivedEmptyBody: 'आप जो समूह संग्रहित करते हैं वे यहाँ दिखते हैं, वापस लाने के लिए तैयार।',
    unarchive: 'वापस लाएँ',
    archivedOn: '{date} को संग्रहित',
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
    role: 'भूमिका',
    makeAdmin: 'एडमिन बनाएँ',
    removeAdmin: 'एडमिन हटाएँ',
    adminNote: 'एडमिन ग्रुप बदल सकते हैं, सदस्य संभाल सकते हैं, और कुल बजट तय कर सकते हैं.',
    adminNeedsAccount: 'ये अभी शामिल नहीं हुए हैं. सिर्फ़ अकाउंट वाला सदस्य ही एडमिन बन सकता है.',
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
    usesBadge: '{count} उपयोग',
    shareMessage:
      'खर्च बाँटने के लिए Baaki पर {group} में शामिल हों — शुरू करने के लिए कोई ऐप या खाता ज़रूरी नहीं: {link}',
    emailSubject: 'Baaki पर {group} में शामिल हों',
    mintMistakeNote:
      'गलती से लिंक बना लिया? नया बनाएँ — पुराना लिंक खत्म होने तक चलता रहेगा, इसलिए वही लिंक साझा करें जो आप चाहते हैं।',
    hideContacts: 'संपर्क छिपाएँ',
    browseContacts: 'मेरे संपर्क देखें',
    contacts: 'संपर्क',
    remind: 'याद दिलाएँ',
    reminded: 'याद दिला दिया',
    remindedToday: 'आज याद दिला चुके',
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
    aBill: 'एक बिल',
    splitBillA11y: '{merchant} को चीज़-वार बाँटें',
    receiptClaimedNone: {
      one: '{n} पंक्ति, अभी किसी ने दावा नहीं किया। जो आपने लिया उसे टैप करें।',
      other: '{n} पंक्तियाँ, अभी किसी ने दावा नहीं किया। जो आपने लिया उसे टैप करें।',
    },
    receiptClaimedSome:
      '{items} में से {claimed} पंक्तियों का दावा हुआ। जो आपने लिया उसे टैप करें।',
    scanReadItemsCta: {
      one: '{n} आइटम पढ़ा — इसके बजाय चीज़-वार बाँटें',
      other: '{n} आइटम पढ़े — इसके बजाय चीज़-वार बाँटें',
    },
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
    disputed: 'विवादित',
    untitled: 'बिना नाम',
    paidByName: '{name} ने भुगतान किया',
    editedTimes: { one: 'एक बार संपादित', other: '{n} बार संपादित' },
    inCount: { one: '{n} खर्च में', other: '{n} खर्चों में' },
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
    peopleSplitting: {
      one: '{n} व्यक्ति यहाँ खर्च बाँट रहा है',
      other: '{n} लोग यहाँ खर्च बाँट रहे हैं',
    },
    peopleCount: { one: '{n} व्यक्ति', other: '{n} लोग' },
    contactsAdded: '{count} जोड़े गए। किसी और को चुनें, या वापस जाएँ।',
    couldNotAdd: '{names} को नहीं जोड़ा जा सका।',
    couldNotAddSome: 'सभी को नहीं जोड़ा जा सका। {reason}',
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
    notSentYet: 'अभी भेजा नहीं गया',
    offlineWithCount: {
      one: 'ऑफ़लाइन — {n} बदलाव इसी फ़ोन पर सेव है',
      other: 'ऑफ़लाइन — {n} बदलाव इसी फ़ोन पर सेव हैं',
    },
    cantReachServer: {
      one: 'सर्वर तक नहीं पहुँच पा रहे — {n} बदलाव यहीं सेव है, भेजने का इंतज़ार',
      other: 'सर्वर तक नहीं पहुँच पा रहे — {n} बदलाव यहीं सेव हैं, भेजने का इंतज़ार',
    },
    syncingCount: { one: '{n} बदलाव भेजा जा रहा है…', other: '{n} बदलाव भेजे जा रहे हैं…' },
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
    dictationErrors: {
      notAllowed: 'माइक्रोफ़ोन के लिए बाकी को अनुमति चाहिए। इसे सेटिंग्स में चालू कर सकते हैं।',
      noSpeech: 'कुछ सुनाई नहीं दिया। माइक पर टैप करके फिर बोलें।',
      audioBusy: 'माइक्रोफ़ोन व्यस्त है। रिकॉर्ड करने वाला कुछ और बंद करके फिर कोशिश करें।',
      network: 'इस फ़ोन पर आवाज़ पहचान के लिए कनेक्शन चाहिए। नोट टाइप कर लें।',
      languageNotSupported: 'यह फ़ोन अभी उस भाषा को नहीं पहचान सकता। नोट टाइप कर लें।',
      stopped: 'बोलकर लिखना रुक गया। नोट टाइप कर लें।',
    },
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
    withLabel: 'किसके साथ',
    settleNoDetailsTitle: '{rail} का विवरण अभी नहीं है',
    settleNoDetailsBody:
      '{name} ने यह नहीं जोड़ा कि उन्हें भुगतान कैसे मिलता है। नकद में निपटाएँ, या उनसे जोड़ने को कहें।',
    settleRailFallback: 'भुगतान',
    settlePayTitle: '{name} को भुगतान करें',
    settlePayBody: '{rail}\n{handle}\n\nफिर वापस आकर दर्ज करें।',
    settleSendTo: 'यहाँ भेजें',
    recordYes: 'हाँ, दर्ज करें',
    recordNo: 'नहीं',
    recordIt: 'दर्ज करें',
    noReasonGiven: 'कोई कारण नहीं दिया गया',
    disputeStands:
      'अभी कुछ नहीं बदला — खर्च ठीक होने तक आपका हिस्सा बना रहता है। यह जानबूझकर है: जिस हिस्से को कोई अकेले हटा सके, वह बहीखाता नहीं होगा।',
    neverMind: 'कोई बात नहीं, ठीक है',
    whatsWrongWithIt: 'इसमें क्या गलत है?',
    somethingsWrong: 'कुछ गलत है',
    tripDatesTitle: 'यात्रा की तारीखें',
    aboutTripDates: 'यात्रा की तारीखों के बारे में',
    tripDatesBody:
      'जब तक यात्रा चलती है, सभी को खर्च जोड़ने का संकेत मिलता है — नाश्ते के समय कल के बारे में, और दिन के अंत में आज के बारे में। जिस दिन को पहले ही जोड़ लिया गया, उसके बारे में किसी से नहीं पूछा जाता।',
    bankRateNote: 'आपके बैंक की दर, मार्कअप सहित — यही आपके स्टेटमेंट में दिखता है।',
    listening: 'सुन रहा है…',
    whereSettle: 'यह समूह कहाँ निपटान करता है?',
    youHaveVersion: 'आपके पास {installed} है',
    versionAvailable: ' · {latest} उपलब्ध है',
    gotIt: 'समझ गया',
    copied: 'कॉपी हो गया',
    tapToCopy: 'कॉपी करने के लिए बटन दबाएँ',
    insightsLiveNote:
      'केवल सक्रिय खर्च — संपादित खर्च अब जो कहता है उसी पर गिना जाता है, और हटाया गया बिल्कुल नहीं गिना जाता। रकम कभी मुद्राओं के बीच नहीं बदली जाती।',
    nameAloneBody:
      'सिर्फ़ एक नाम काफ़ी है — बँटवारे में शामिल होने के लिए किसी को ऐप या ईमेल की ज़रूरत नहीं। पता होने का मतलब बस इतना कि आप उन्हें लिंक भेज सकते हैं। बाद में जब वे जुड़ते हैं, तो अपने नाम पर दर्ज सब कुछ अपना बना सकते हैं।',
    noUpiYet: 'अभी कोई UPI आईडी नहीं',
    csvCurrencyMismatch:
      'यह फ़ाइल {fileCur} में है और यह समूह अपना पैसा {groupCur} में रखता है। इसे आयात करने के लिए हर पंक्ति के लिए एक दर चाहिए, और फ़ाइल में वह नहीं है — इसके बजाय एक {fileCur} समूह शुरू करें।',
    rateFetchFailedSuffix: ' — आप दर खुद टाइप कर सकते हैं',
    settlesInHint: 'यह समूह {currency} में हिसाब करता है',
    howDoYouKnowRate: 'यह समूह {currency} में हिसाब करता है। दर आपको कैसे पता है?',
    todaysRate: 'आज की दर',
    statementAmountLabel: 'आपके स्टेटमेंट पर रकम, {currency} में',
    amountChargedIn: '{currency} में ली गई रकम',
    fxOneEquals: '1 {from} = ? {to}',
    fxRateFromTo: '{from} से {to} की दर',
    convertedApprox: '≈ {amount} ({currency} में)',
    rateStoredNote:
      'दर {rate}, {source} से। खर्च के साथ सहेजी गई है, इसलिए बाद में भी यही रूपांतरण होगा।',
    rateSourceEcb: 'ECB',
    rateSourceImplied: 'आपके स्टेटमेंट',
    rateSourceYou: 'आप',
    noRateNote:
      'दर के बिना भी खर्च सहेजा जाता है — यह {currency} में ही रहता है, और समूह एक अलग {currency} बैलेंस रखता है।',
    thinkThisOff: {
      one: 'किसी को लगता है कि यह ठीक नहीं है',
      other: '{n} लोगों को लगता है कि यह ठीक नहीं है',
    },
    sending: 'भेज रहे हैं…',
    tellThem: 'उन्हें बताएँ',
    versionStoppedBody:
      'यह संस्करण अब बाकी से बात नहीं कर सकता, इसलिए ग़लत आँकड़े दिखाने के बजाय इसे रोक दिया गया है।',
    newBaakiOut: 'नया बाकी आ गया है',
    baakiVersionOut: 'बाकी {latest} आ गया है',
  },
  smsImport: {
    title: 'संदेशों से आयात',
    howTo:
      'अपना मैसेज ऐप खोलें, इस यात्रा के बैंक संदेश चुनें, कॉपी करें और यहाँ पेस्ट करें। बाकी उन्हें इसी फ़ोन पर पढ़ता है — जब तक आप कोई खर्च पक्का नहीं करते, कुछ भी कहीं नहीं भेजा जाता।',
    whyNotAutomatic:
      'बाकी आपका इनबॉक्स खुद नहीं पढ़ सकता। iPhone किसी भी ऐप को यह पहुँच नहीं देता, और Android पर यह सिर्फ़ उसी ऐप के लिए है जिसे आप मैसेज ऐप की तरह इस्तेमाल करते हैं।',
    messagesSection: 'संदेश',
    pasteLabel: 'बैंक संदेश पेस्ट करें',
    pastePlaceholder: 'यहाँ पेस्ट करें।\n\nसंदेशों के बीच एक खाली पंक्ति छोड़ें।',
    nothingPasted: 'अभी कुछ पेस्ट नहीं किया',
    messageCount: { one: '{n} संदेश', other: '{n} संदेश' },
    paste: 'पेस्ट',
    datesSection: 'इन तारीखों के बीच',
    datesNote: 'सिर्फ़ इस अवधि के भुगतान सुझाए जाते हैं, ताकि आपका बाकी इनबॉक्स समूह से बाहर रहे।',
    from: 'से',
    to: 'तक',
    last7: 'पिछले 7 दिन',
    last30: 'पिछले 30 दिन',
    datePlaceholder: 'YYYY-MM-DD',
    dateFieldLabel: '{label} तारीख़, साल महीना दिन',
    foundSection: 'क्या मिला',
    nothingToImport: 'आयात करने को कुछ नहीं',
    nothingLikeAPayment:
      'इन तारीखों के भीतर उन संदेशों में से कोई भुगतान जैसा नहीं लगा। याद दिलाने वाले संदेश, वन-टाइम पासवर्ड और आने वाला पैसा जान-बूझकर छोड़े जाते हैं।',
    allAnotherCurrency: 'जो भी भुगतान मिला वह दूसरी मुद्रा में था।',
    cardPayment: 'कार्ड भुगतान',
    selected: 'चुना गया',
    notSelected: 'नहीं चुना',
    checkThis: 'इसे जाँचें',
    otherCurrencyNote: {
      one: '{n} भुगतान दूसरी मुद्रा में था। उसे हाथ से जोड़ें — संदेश यह नहीं बताता कि आपसे कौन-सी दर ली गई, और यह समूह अपना हिसाब {currency} में रखता है।',
      other:
        '{n} भुगतान दूसरी मुद्रा में थे। उन्हें हाथ से जोड़ें — संदेश यह नहीं बताते कि आपसे कौन-सी दर ली गई, और यह समूह अपना हिसाब {currency} में रखता है।',
    },
    whoPaidSection: 'किसने दिया',
    whoPaidNote:
      'बैंक संदेश बताता है कि आपके खाते से क्या गया, यह नहीं कि वहाँ कौन था। ये समूह के सबके बीच बराबर बाँटे जाते हैं — बाद में किसी को भी बदल सकते हैं।',
    addedCount: {
      one: '{n} खर्च जुड़ा। यह इसी फ़ोन पर सेव है और कनेक्शन मिलते ही सिंक हो जाएगा।',
      other: '{n} खर्च जुड़े। ये इसी फ़ोन पर सेव हैं और कनेक्शन मिलते ही सिंक हो जाएँगे।',
    },
    adding: 'जोड़ रहे हैं…',
    nothingSelected: 'कुछ नहीं चुना',
    addCount: { one: '{n} खर्च जोड़ें', other: '{n} खर्च जोड़ें' },
    readMessages: 'मेरे संदेश पढ़ें',
    reading: 'पढ़ रहे हैं…',
    readOnAndroid:
      'Android पर, Baaki इन तारीखों के बैंक संदेश आपके लिए पढ़ सकता है। यह पहले अनुमति माँगता है, इसी फ़ोन पर पढ़ता है, और जब तक आप किसी खर्च की पुष्टि नहीं करते तब तक कुछ भी कहीं नहीं भेजा जाता।',
    readCount: {
      one: 'आपके इनबॉक्स से {n} संदेश पढ़ा गया।',
      other: 'आपके इनबॉक्स से {n} संदेश पढ़े गए।',
    },
    readNothing: 'इन तारीखों में कोई बैंक संदेश नहीं मिला।',
    permissionDenied:
      'संदेश पढ़ने के लिए Baaki को आपकी अनुमति चाहिए। आप नीचे उन्हें पेस्ट भी कर सकते हैं।',
    permissionBlocked:
      'Baaki के लिए संदेश एक्सेस बंद है। इसे Settings › Apps › Baaki › Permissions में चालू करें, या नीचे संदेश पेस्ट करें।',
    readUnsupported: 'संदेश पढ़ना केवल Android पर काम करता है। नीचे उन्हें पेस्ट करें।',
    readUnavailable: 'यह बिल्ड संदेश नहीं पढ़ सकता। नीचे उन्हें पेस्ट करें।',
    readFailed: 'आपके संदेश पढ़े नहीं जा सके। नीचे उन्हें पेस्ट करें।',
    permissionRationale: {
      title: 'बैंक संदेश पढ़ें',
      message:
        'आपकी यात्रा के ख़र्चे सुझाने के लिए बाकी इस फ़ोन पर बैंक भुगतान संदेश पढ़ता है। संदेश आपके फ़ोन पर ही रहते हैं — जब तक आप कोई ख़र्च पुष्टि न करें, कुछ भी कहीं नहीं भेजा जाता।',
      allow: 'अनुमति दें',
      notNow: 'अभी नहीं',
    },
    dateNotInMessage: 'संदेश में तारीख नहीं थी',
  },
  itemize: {
    title: 'चीज़-वार बाँटें',
    notAMember: 'आप इस समूह के सदस्य नहीं हैं',
    invalidTaxOrTip: 'कर और टिप के लिए मान्य राशि दर्ज करें।',
    defaultDescription: 'चीज़-वार बिल',
    sharedNow: 'अब समूह के सब लोग यह बिल देख सकते हैं। जो आपने लिया उन पंक्तियों पर टैप करें।',
    splittingTogether: 'साथ मिलकर बाँट रहे हैं',
    splittingTogetherNote:
      'समूह के सब लोग ये पंक्तियाँ देख रहे हैं। जो आपने लिया उन पर टैप करें — वे इसे होते हुए देखेंगे। अब पंक्तियाँ बदली नहीं जा सकतीं, क्योंकि हर दावा अपनी पंक्ति से जुड़ा है।',
    everyoneHasAPhone: 'मेज़ पर सबके पास फ़ोन है?',
    handOverNote:
      'ये पंक्तियाँ समूह को दे दें और हर कोई अपने फ़ोन पर टैप करे कि उसने क्या लिया। पहले पंक्तियाँ जाँच लें — जैसे ही किसी ने एक पर दावा किया, सूची पक्की हो जाती है।',
    sharing: 'साझा कर रहे हैं…',
    splitTogether: 'साथ में बाँटें',
    whatWasTheBillFor: 'बिल किस चीज़ का था?',
    descriptionPlaceholder: 'अंजप्पर में खाना',
    descriptionLabel: 'बिल का विवरण',
    addALine: 'एक पंक्ति जोड़ें',
    itemPlaceholder: 'बिरयानी',
    itemName: 'चीज़ का नाम',
    itemAmount: 'चीज़ की रकम',
    unclaimed: 'इस पर किसी ने दावा नहीं किया',
    splitWays: { one: 'एक व्यक्ति के लिए', other: '{n} लोगों में बँटा' },
    taxAndTipNote: 'टैक्स और टिप — हर किसी के ऑर्डर के अनुपात में',
    taxRow: 'टैक्स / सेवा',
    tipRow: 'टिप',
    taxAmount: 'टैक्स की रकम',
    tipAmount: 'टिप की रकम',
    total: 'कुल',
    someone: 'कोई',
    waitingForLines: 'इस बिल की पंक्तियों का इंतज़ार है।',
    addTheLines: 'बिल की पंक्तियाँ जोड़ें और टैप करें कि किसने क्या लिया।',
    stillUnclaimed: {
      one: '{n} पंक्ति पर अब भी दावा नहीं — जो किसी ने मँगाया ही नहीं उसका पैसा कोई नहीं देता।',
      other:
        '{n} पंक्तियों पर अब भी दावा नहीं — जो किसी ने मँगाया ही नहीं उसका पैसा कोई नहीं देता।',
    },
    tapWhoHadEach: 'बँटवारा देखने के लिए टैप करें कि हर पंक्ति किसने ली।',
    taxAndTipShared: '{amount} का टैक्स और टिप हर किसी की चीज़ों के अनुपात में बाँटा जाता है।',
    scanTitle: 'रसीद स्कैन करें',
    scanBody:
      'बिल स्कैन करें और आइटम अपने आप भर जाते हैं। सेव करने से पहले उन्हें जाँच लें — हाथ से भरना हमेशा मुफ़्त है।',
    scanReadItems: {
      one: '{n} आइटम पढ़ा। उसे जाँचें, फिर टैप करें कि किसने क्या लिया।',
      other: '{n} आइटम पढ़े। उन्हें जाँचें, फिर टैप करें कि किसने क्या लिया।',
    },
    scanCheckLines: 'सेव करने से पहले कुछ पंक्तियों की जाँच ज़रूरी है।',
    carriedOver: 'स्कैन से लाया गया। पंक्तियाँ जाँचें, फिर टैप करें कि किसने क्या लिया।',
    notYours: 'वे Baaki पर हैं — वे अपनी पंक्तियाँ ख़ुद टैप करते हैं।',
    itemFallback: 'आइटम {n}',
    removeItem: '{label} हटाएँ',
    hadItem: '{name} ने {label} लिया',
  },
  importLedger: {
    splitwiseTitle: 'Splitwise निर्यात आयात करें',
    ledgerTitle: 'हिसाब आयात करें',
    splitwiseHowTo:
      'Splitwise में समूह खोलें, Export as spreadsheet चुनें, और वह फ़ाइल यहाँ चुनें।',
    bringHistory: 'अपना इतिहास ले आएँ',
    free: 'मुफ़्त',
    ledgerHowTo:
      'Splitwise से: समूह खोलें → ⚙ मेनू → Export as spreadsheet, और वही CSV यहाँ चुनें। बाकी से: सेटिंग्स से निर्यात की गई JSON फ़ाइल चुनें। उसमें जिनका नाम है वे सब समूह के सदस्य बन जाते हैं — उन्हें ऐप की ज़रूरत नहीं, और जब वे जुड़ेंगे तब अपना इतिहास ले सकते हैं।',
    chooseFile: 'फ़ाइल चुनें',
    chosenFile: 'चुनी गई: {name}',
    chooseDifferentFile: 'दूसरी फ़ाइल चुनें',
    whichGroup: 'कौन-सा समूह',
    groupNumber: 'समूह {n}',
    whoIsWho: 'कौन कौन है',
    whoIsWhoNote:
      'फ़ाइल में नाम हैं; इस समूह में सदस्य हैं। जब तक हर नाम के सामने कोई नहीं होगा, कुछ भी आयात नहीं होगा।',
    tapANameNote:
      'किसी नाम पर टैप करके बताएँ कि यहाँ वे कौन हैं। आपकी तरफ़ से नाम से कोई मिलान नहीं किया जाता — दो लोग सचमुच रवि हो सकते हैं।',
    addAsNew: 'नए के रूप में जोड़ें',
    newPerson: 'नया व्यक्ति',
    importedGroup: 'आयातित समूह',
    rowsLeftOut: 'छोड़ी गई पंक्तियाँ',
    rowsLeftOutNote:
      'बाकी सब फिर भी आयात होता है। इनके नाम इसलिए दिए हैं ताकि आप इन्हें हाथ से जोड़ सकें, न कि बाद में पता चले कि ये गायब हैं।',
    fileWide: 'फ़ाइल',
    rowNumber: 'पंक्ति {n}',
    whereItGoes: 'कहाँ जाएगा',
    aNewGroup: 'एक नया समूह',
    namedAfterFile: 'फ़ाइल के नाम पर',
    addToThisGroup: 'इसी समूह में जोड़ें',
    importing: 'आयात हो रहा है…',
    importCount: { one: '{n} खर्च आयात करें', other: '{n} खर्च आयात करें' },
    chooseWhoIs: 'चुनें कि {name} कौन हैं',
    chooseWhoArePlural: {
      one: 'चुनें कि {n} व्यक्ति कौन है',
      other: 'चुनें कि {n} लोग कौन हैं',
    },
    tapYourNameFirst: 'पहले उस नाम पर टैप करें जो आप हैं — वरना यह इतिहास आपका नहीं होगा।',
    imported: 'आयात हो गया',
    openTheGroup: 'समूह खोलें',
    importedCount: {
      one: '{n} खर्च आयात हुआ। यह इसी फ़ोन पर सेव है और कनेक्शन मिलते ही सिंक हो जाएगा।',
      other: '{n} खर्च आयात हुए। ये इसी फ़ोन पर सेव हैं और कनेक्शन मिलते ही सिंक हो जाएँगे।',
    },
    expenseCount: { one: '{n} खर्च', other: '{n} खर्च' },
    settlementCount: { one: '{n} निपटान', other: '{n} निपटान' },
    peopleCount: { one: '{n} व्यक्ति', other: '{n} लोग' },
    peopleAdded: {
      one: '{n} व्यक्ति जोड़ा गया, दावे का इंतज़ार',
      other: '{n} लोग जोड़े गए, दावे का इंतज़ार',
    },
    rowsSkipped: { one: '{n} पंक्ति छोड़ी जाएगी', other: '{n} पंक्तियाँ छोड़ी जाएँगी' },
    andMore: '…और {n} अन्य।',
    fromBaakiNote:
      'हर हिसाब पाई-पाई सहित आता है, निपटान भी। जो नहीं आता: हर खर्च का संपादन इतिहास, और यह कि कोई पुराना भुगतान किन खर्चों पर लगाया गया था। इनमें से कोई भी यह नहीं बदलता कि किस पर क्या बाकी है।',
    fromSplitwiseNote:
      'हिसाब बिल्कुल सही आता है। किसने दिया, यह नहीं: Splitwise निर्यात सिर्फ़ यह दर्ज करता है कि एक पंक्ति पर हर व्यक्ति कितना ऊपर या नीचे रहा, और कई अलग-अलग भुगतानकर्ता एक ही नतीजा देते हैं। हर आयातित खर्च पर निशान लगा होता है, और आप किसी को भी ठीक कर सकते हैं।',
    otherCurrenciesNote:
      'नीचे की रकमें {currency} वाली हैं। {others} भी आती हैं, और कभी बदली नहीं जातीं।',
    noGroupsInFile: 'उस फ़ाइल में आयात करने के लिए कोई समूह नहीं है।',
    couldNotFindYou: 'उस समूह में आप नहीं मिले। उसे खोलकर फिर कोशिश करें।',
  },
  pickers: {
    contactsDenied:
      'बाकी आपके संपर्क नहीं देख सकता। आप फिर भी नाम, ईमेल या नंबर टाइप करके लोग जोड़ सकते हैं — समूह के लिए आपकी संपर्क सूची ज़रूरी नहीं।',
    openSettings: 'सेटिंग्स खोलें',
    contactsUnavailable:
      'बाकी इस फ़ोन की संपर्क सूची नहीं पढ़ सका। आपकी अनुमतियों में कोई गड़बड़ नहीं है — इसके बजाय नाम, ईमेल या नंबर टाइप करके लोग जोड़ें।',
    tryAgain: 'फिर कोशिश करें',
    searchContacts: 'संपर्क खोजें',
    contactCount: { one: '{n} संपर्क', other: '{n} संपर्क' },
    clearSearch: 'खोज मिटाएँ',
    nobodyHere: 'यहाँ कोई नहीं',
    noContactMatches: 'उससे कोई संपर्क नहीं मिला।',
    noneHasEmailOrNumber: 'आपके किसी संपर्क के पास ईमेल या नंबर नहीं है।',
    onlyPickedAreSent:
      'सिर्फ़ वही लोग बाकी को भेजे जाते हैं जिन्हें आप चुनते हैं। आपके संपर्क इसी फ़ोन पर रहते हैं।',
    jumpToLetter: 'किसी अक्षर पर जाएँ',
    country: 'देश',
    dialCodeTitle: 'देश कोड',
    searchCountry: 'देश खोजें',
    settlesWith: '{country} · {rails} से निपटान',
    notSet: 'तय नहीं',
    notSetRails: 'बैंक ट्रांसफ़र, नकद, Wise और Revolut',
    countryNote:
      'इससे तय होता है कि आप एक-दूसरे को कैसे पैसे दे सकते हैं, और नया खर्च किस मुद्रा में शुरू होगा। जो पहले से दर्ज है वह नहीं बदलता।',
    starts: 'शुरू',
    ends: 'समाप्त',
    dailyReminders: 'रोज़ाना याद दिलाना',
    breakfast: 'नाश्ता',
    endOfDay: 'दिन का अंत',
    clearDates: 'तारीखें हटाएँ',
    nobodyPickedYet: 'अभी किसी को नहीं चुना',
    personCount: { one: '{n} व्यक्ति', other: '{n} लोग' },
    alreadyAddedName: '{name}, पहले से जुड़ा है',
    alreadyInGroup: 'पहले से इस समूह में है',
    removeName: '{name} को हटाएँ',
    remindZoneNote: '{zone} में पूछा जाता है — जहाँ यात्रा है, न कि जहाँ हर कोई है।',
    useMyTimezone: 'मेरा टाइमज़ोन इस्तेमाल करें ({zone})',
  },
  dispute: {
    yourReply: 'आपका जवाब',
    replyPlaceholder: 'वैकल्पिक — असल में क्या हुआ',
    saving: 'सेव हो रहा है…',
    theyAreRight: 'वे सही हैं — मैं ठीक कर दूँगा',
    itIsCorrect: 'यह सही है',
    answerThis: 'इसका जवाब दें',
    youSaidWrong: 'आपने कहा यह ग़लत है',
    whatIsWrong: 'इस खर्च में क्या ग़लत है',
    reasonPlaceholder: 'मैं मिठाई से पहले निकल गया · कुल ₹1,800 था',
    reasonOptional: 'वजह देना ज़रूरी नहीं, पर सुधार और बहस के बीच का फ़र्क़ यही है।',
    fixItMyself: 'मैं खुद ठीक कर दूँ',
  },
  upgradeScreen: {
    moreScans: 'ज़्यादा बिल स्कैन',
    moreScansBody:
      'रसीद की फ़ोटो लें और उसकी पंक्तियाँ पढ़ ली जाएँ। हर स्कैन पर सचमुच पैसा लगता है — यही ईमानदार वजह है कि सीमा इसी पर है।',
    biggerTransfers: 'बड़े निर्यात और आयात',
    biggerTransfersBody:
      'आपका डेटा आपका है और पूरा मुफ़्त में बाहर आता है। बड़े काम और तय समय पर बैकअप — यही सुविधा है।',
    nothingToBuy: 'अभी खरीदने को कुछ नहीं',
    nothingToBuyBody:
      'यह दुकान नहीं, दरवाज़ा है। जब कुछ ऐसा होगा जिसके पैसे देने लायक हो, वह यहीं मिलेगा — कीमत लिखी हुई और कोई चौंकाने वाली बात नहीं।',
    whatWouldCost: 'कभी पैसे किस चीज़ के लगेंगे',
    whatNeverWill: 'किसके कभी नहीं',
    whatNeverWillBody:
      'हिसाब। समूह, खर्च, बँटवारा, बकाया, निपटान, और यह सब वापस बाहर निकालना — {free}। जो हिसाब आप आधा ही पढ़ सकें, वह हिसाब नहीं।',
  },
  promo: {
    row: 'कोड इस्तेमाल करें',
    rowHint: 'अगर किसी ने आपको दिया हो',
    title: 'कोड इस्तेमाल करें',
    intro: 'कोड हाथ से दिए जाते हैं — किसी मदद के लिए, शुक्रिया के तौर पर, या आज़माने के लिए।',
    placeholder: 'BAAKI2026',
    redeem: 'इस्तेमाल करें',
    granted: 'हो गया',
    grantedBody: '{until} तक Plus चालू है। कुछ नहीं लिया गया, और कुछ अपने आप नहीं बढ़ेगा।',
    unknownCode: 'ऐसा कोई कोड नहीं। वर्तनी जाँच लें — सिर्फ़ अक्षर और अंक।',
    expired: 'उस कोड की तारीख़ निकल चुकी है।',
    exhausted: 'वह कोड जितनी बार चल सकता था, उतनी बार चल चुका।',
    alreadyRedeemed: 'आप उसे पहले ही इस्तेमाल कर चुके हैं।',
    couldNotRedeem: 'अभी कोड जाँचा नहीं जा सका। थोड़ी देर बाद कोशिश करें।',
  },
  claims: {
    askToJoinAs: '{name} के रूप में शामिल होने की पूछें',
    needsConfirming: 'समूह का कोई एडमिन पुष्टि करेगा, उसके बाद ही कुछ बदलेगा।',
    waitingTitle: 'पूछ लिया',
    waitingBody:
      '{group} चलाने वाले किसी को पुष्टि करनी है कि आप {name} हैं। जवाब जो भी हो, आपको पता चलेगा — समूह में अभी कुछ नहीं बदला।',
    joinAsNewInstead: 'नए व्यक्ति के रूप में शामिल हों',
    requestsTitle: 'शामिल होने के इंतज़ार में',
    saysTheyAre: '{who} कहते हैं कि वे {name} हैं',
    approve: 'पुष्टि करें',
    decline: 'ये वो नहीं',
    decideFailed: 'अभी जवाब नहीं दिया जा सका। थोड़ी देर बाद कोशिश करें।',
    alreadyDecided: 'इसका जवाब कोई पहले ही दे चुका है।',
    placeTaken: 'वह जगह अब किसी और की है।',
    theyAreAlreadyIn: 'वे पहले से इस समूह में हैं।',
  },
  privacy: {
    row: 'निजता और सुरक्षा',
    rowHint: 'क्या रखा जाता है, और कैसे सुरक्षित रहता है',
    title: 'निजता और सुरक्षा',
    intro:
      'बाकी आपके बारे में उतना ही रखता है जितना काम करने के लिए ज़रूरी है। वह क्या है, सीधे शब्दों में।',
    storeTitle: 'क्या रखा जाता है',
    storeBody:
      'आपका नाम, और फ़ोन नंबर, ईमेल या साइन-इन पहचान में से जो आपने इस्तेमाल किया। वैकल्पिक रूप से एक भुगतान पता, ताकि कोई आपको लौटा सके, और एक देश। आप जिन समूहों में हैं, उनके ख़र्चे, और कौन किसका देनदार है। और कुछ नहीं: कोई संपर्क अपलोड नहीं होते, कोई विज्ञापन पहचानकर्ता नहीं।',
    protectTitle: 'कैसे सुरक्षित रहता है',
    protectBody:
      'हर तालिका डेटाबेस में row-level security के पीछे है — ऐप का लगाया फ़िल्टर नहीं, बल्कि डेटाबेस का लागू किया नियम। रसीद की तस्वीरें एक निजी जगह में, छोटी अवधि के लिंक से ही पहुँच में। क्रैश रिपोर्ट से पते, नंबर और भुगतान पते फ़ोन छोड़ने से पहले ही हटा दिए जाते हैं।',
    choicesTitle: 'आप क्या कर सकते हैं',
    choicesBody:
      'जो कुछ आपने डाला है, कभी भी, पूरा और मुफ़्त निर्यात करें। कोई भी सूचना बंद करें। अपना खाता और उसमें रखा निजी डेटा मिटाएँ।',
    englishGoverns:
      'यह पाठ सुविधा के लिए अनूदित है। अनुवाद और अंग्रेज़ी में अंतर हो तो अंग्रेज़ी ही मान्य होगी।',
    couldNotSave: 'यह सहेजा नहीं जा सका। थोड़ी देर बाद फिर कोशिश करें।',
    analyticsTitle: 'ऐप कैसे इस्तेमाल होता है',
    analyticsBody:
      'Microsoft Clarity के ज़रिए यह दर्ज किया जा सकता है कि कौन-सी स्क्रीन उलझाती है। यह बंद अवस्था में ही आता है और चालू किए बिना कुछ दर्ज नहीं करता। इसका उपयोग विज्ञापन के लिए कभी नहीं होता, कोई विज्ञापन पहचानकर्ता नहीं है, और कुछ भी बेचा या साझा नहीं जाता।',
    sessionReplayRow: 'ऐप के मेरे इस्तेमाल को दर्ज करने दें',
    previewGroups: { one: 'आप {n} समूह में हैं।', other: 'आप {n} समूहों में हैं।' },
    previewExpenses: {
      one: 'आपका डाला {n} ख़र्च बना रहेगा।',
      other: 'आपके डाले {n} ख़र्चे बने रहेंगे।',
    },
    previewSettlements: {
      one: '{n} भुगतान में आपका नाम है।',
      other: '{n} भुगतानों में आपका नाम है।',
    },
    previewOutstanding: '{list} में अब भी बकाया है।',
    feedbackRow: 'सुझाव भेजें',
    feedbackRowHint: 'बताइए क्या ग़लत है, या क्या नहीं है',
    feedbackTitle: 'सुझाव भेजें',
    feedbackHint:
      'इसे एक व्यक्ति पढ़ता है। जितना चाहें लिखें — विशिष्ट होने पर सबसे ज़्यादा मदद मिलती है।',
    feedbackPlaceholder: 'क्या हुआ, या आप क्या चाहते थे कि यह करे',
    feedbackSend: 'भेजें',
    feedbackThanks: 'धन्यवाद — मिल गया।',
    kindGeneral: 'सामान्य',
    kindBug: 'कुछ ख़राब है',
    kindIdea: 'एक सुझाव',
    deleteRow: 'मेरा डेटा मिटाएँ',
    deleteRowHint: 'अपना खाता और निजी विवरण हटाएँ',
    deleteTitle: 'मेरा डेटा मिटाएँ',
    deleteIntro:
      'यह वापस नहीं हो सकता। पढ़िए कि क्या हटता है और क्या नहीं — दूसरा हिस्सा ही लोगों को चौंकाता है।',
    deleteGoesTitle: 'क्या हटता है',
    deleteGoesBody:
      'आपका नाम, फ़ोटो, भुगतान पता, देश, भाषा और सूचना सेटिंग्स। आपका साइन-इन, ताकि यह खाता फिर न खुले। आपके उपकरण, सूचना इतिहास और ख़रीद।',
    deleteStaysTitle: 'क्या रहता है, और क्यों',
    deleteStaysBody:
      'आपके साझा समूहों के ख़र्चे और भुगतान रहते हैं, क्योंकि वे दूसरों के भी रिकॉर्ड हैं — वही बताते हैं कि कौन किसका देनदार है। उन्हें हटाने से किसी और का हिसाब चुपचाप बदल जाएगा और वह कर्ज़ चुक जाएगा जो किसी ने चुकाया ही नहीं। आप उन समूहों में एक अनाम पूर्व-सदस्य बन जाते हैं।',
    deleteExportFirst: 'पहले अपना डेटा निर्यात करें',
    deleteWhyLabel: 'आप क्यों जा रहे हैं? (वैकल्पिक)',
    deleteWhyPlaceholder: 'जानना मददगार है; खाता जाने के बाद भी यह रखा जाता है',
    deleteConfirmLabel: 'पुष्टि के लिए DELETE लिखें',
    deleteConfirmWord: 'DELETE',
    deleteButton: 'मेरा डेटा मिटाएँ',
    deleteWorking: 'मिटाया जा रहा है…',
    deleteDone: 'आपका डेटा मिटा दिया गया।',
    deleteSummary: {
      one: 'अब आप {n} समूह के पूर्व-सदस्य हैं।',
      other: 'अब आप {n} समूहों के पूर्व-सदस्य हैं।',
    },
  },
  extras: {
    blankNameHint: 'खाली छोड़ दें तो समूह का नाम उसमें शामिल लोगों पर रख दिया जाएगा।',
    whatKindOfGroup: 'किस तरह का समूह?',
    typeTrip: 'यात्रा',
    typeHome: 'घर',
    typeCouple: 'जोड़ा',
    typeEvent: 'आयोजन',
    typeOther: 'अन्य',
    addPeopleByName: 'दोस्त जोड़ें',
    ghostNote: 'उन्हें ऐप की ज़रूरत नहीं। अभी जोड़ दें, बाद में वे अपना इतिहास ले सकते हैं।',
    claimHistoryNote: 'अपना नाम चुनें और आपके लिए जो कुछ पहले से दर्ज है, सब साथ आ जाएगा।',
    theirPastBecomesYours: 'उनके पुराने खर्च और हिसाब आपके हो जाएँगे।',
    guestKeepsItHere:
      'मेहमान के तौर पर जुड़ने से सब कुछ इसी डिवाइस पर रहता है। बाद में फ़ोन नंबर जोड़ें और सब कुछ दूसरे फ़ोन तक आपके साथ चला आएगा।',
    lockedTitle: 'बाकी लॉक है',
    lockedBody: 'उसी चेहरे या फ़िंगरप्रिंट से खोलें जिससे यह फ़ोन खुलता है।',
    unlock: 'खोलें',
    paidIn: 'इसमें दिया',
    iKnowTheRate: 'मुझे दर पता है',
    notAnAmountShort: 'रकम नहीं',
    oneChangeFailed: 'एक बदलाव सेव नहीं हो सका',
    tryAgain: 'फिर कोशिश करें',
    discardIt: 'इसे छोड़ दें',
    needsUpdating: 'बाकी को अपडेट चाहिए',
    nothingIsLost:
      'कुछ नहीं खोया। हर समूह, खर्च और निपटान सर्वर पर है और ठीक वहीं मिलेगा जहाँ आपने छोड़ा था।',
    worthAMinute: 'जब वक़्त मिले तो एक मिनट देने लायक।',
    theGroup: 'समूह',
    noGroupsYet:
      'आपके अभी कोई समूह नहीं हैं। बाकी में हर व्यक्ति किसी समूह का होता है, क्योंकि उधार हमेशा किसी चीज़ का होता है — कोई यात्रा, कोई घर, कोई खाना।',
    ghostShareNote:
      'उन्हें ऐप की ज़रूरत नहीं। उनका हिस्सा उन्हीं के नाम दर्ज होता है, और अगर वे बाद में इसी ईमेल या नंबर से जुड़ते हैं तो वहाँ रखा सब कुछ ले लेते हैं।',
    justMe: 'सिर्फ़ मैं',
    yourShareNote: 'सिर्फ़ मैं — हर राशि आपका हिस्सा है, पूरा खर्च नहीं।',
    sms: 'SMS',
    email: 'ईमेल',
    paymentWentThrough: 'क्या भुगतान हो गया?',
    onlyIfCompleted: 'तभी दर्ज करें जब वह सचमुच पूरा हो गया हो।',
    restAppliesOverall: 'बाकी कुल हिसाब पर लगता है, सबसे पुराना खर्च पहले।',
    couldNotReadImage: 'वह तस्वीर पढ़ी नहीं जा सकी।',
    deliveryComesLater: 'पुश और ईमेल डिलीवरी M4 के साथ आएँगे। तब तक सब कुछ यहीं आकर जमा होता है।',
    perCurrencyNote:
      'रकमें हर मुद्रा के हिसाब से अलग रखी जाती हैं, कभी एक कुल में नहीं बदली जातीं। जिनका खाता नहीं है उन्हें हर समूह में अलग गिना जाता है, क्योंकि दो लोगों का नाम एक हो सकता है।',
    savedStraightAway:
      'सिग्नल हो या न हो, इसी फ़ोन पर तुरंत सेव। सर्वर हर हिस्सा दोबारा जोड़कर ही रखता है, इसलिए कोई डिवाइस हिसाब में ग़लत आँकड़ा नहीं डाल सकती।',
    nothingOverwritten:
      'यहाँ कुछ भी मिटाकर ऊपर नहीं लिखा जाता। ऊपर का हर संस्करण रखा जाता है, और हटाया गया खर्च 30 दिन तक वापस लाया जा सकता है।',
  },
  errorBoundary: {
    title: 'कुछ गड़बड़ हो गई',
    body: 'उस स्क्रीन में कोई त्रुटि आ गई। आपका सहेजा हुआ कुछ भी नहीं खोया — वापस जाकर फिर कोशिश करें।',
    action: 'होम पर वापस',
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
  acrossGroups: {
    zero: 'في {n} مجموعة',
    one: 'في مجموعة واحدة',
    two: 'في مجموعتين',
    few: 'في {n} مجموعات',
    many: 'في {n} مجموعة',
    other: 'في {n} مجموعة',
  },
  youAreOwed: 'لك',
  youOwe: 'عليك',
  allSettled: 'تمت التسوية',
  yourGroups: 'مجموعاتك',
  filterAll: 'الكل',
  newGroup: 'مجموعة جديدة',
  activity: 'النشاط',
  friends: 'الأصدقاء',
  sort: { by: 'ترتيب حسب', amount: 'المبلغ', date: 'النشاط الأخير', name: 'الاسم' },
  addPerson: {
    title: 'إضافة شخص',
    subtitle: 'تتبّع ما يدين لك به أحدهم — لا يحتاج إلى التطبيق، ولا إلى إنشاء مجموعة.',
    nameLabel: 'اسمه',
    namePlaceholder: 'مثل: رافي',
    amountLabel: 'المبلغ',
    directionQuestion: 'في أي اتجاه؟',
    theyOweMe: 'يدين لي',
    iOweThem: 'أدين له',
    noteLabel: 'ملاحظة (اختياري)',
    notePlaceholder: 'لأجل ماذا؟',
    save: 'سجّل',
    couldNotRecord: 'تعذّر تسجيل هذا. حاول مرة أخرى.',
  },
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
  payViaRail: 'ادفع عبر {rail}',
  youPayName: 'تدفع لـ {name}',
  namePaysYou: 'يدفع لك {name}',
  settleConfirmYouPay: 'سيُطلب من {name} التأكيد. لا تنتقل الأموال عبر Baaki.',
  settleConfirmTheyPay: 'سيُطلب منك التأكيد بمجرد أن يضع علامة الدفع.',
  members: 'الأعضاء',
  memberCount: {
    zero: '{n} عضو',
    one: 'عضو واحد',
    two: 'عضوان',
    few: '{n} أعضاء',
    many: '{n} عضوًا',
    other: '{n} عضو',
  },
  notJoinedYet: 'لم ينضم بعد',
  scansLeft: 'عمليات مسح متبقية',
  simplifyOn: 'التبسيط مفعّل',
  simplifyOff: 'التبسيط متوقف',
  simplifySuggestBody:
    'يقترح Baaki أقل عدد من الدفعات لتسوية المجموعة. أمّا سجل مَن يدين لِمَن الحقيقي في الأسفل فلا يُعاد كتابته أبداً.',
  simplifyPairwiseBody: 'يعرض السجل الثنائي الفعلي تماماً كما أنشأته المصروفات.',
  simplifyPaymentsCount: { one: 'دفعة واحدة', other: '{n} دفعات' },
  simplifyPaysWhom: 'يدفع {from} لـ {to}',
  simplifyYouPay: 'تدفع',
  simplifyYouReceive: 'تستلم',
  freeForever: 'بلا حدود ومجاني، للأبد',
  nothingYet: 'لا شيء هنا بعد',
  nothingYetBody: 'أضف أول مصروف والحساب يتكفل بنفسه.',
  loadError: 'تعذّر تحميل هذا',
  loadErrorBody: 'تحقّق من اتصالك واسحب للتحديث، أو أعد المحاولة.',
  retry: 'حاول مرة أخرى',
  whatFor: 'نوع المصروف',
  spending: 'الإنفاق',
  byCategory: 'أين ذهبت',
  byMonth: 'شهراً بشهر',
  totalIn: 'الإجمالي بعملة {currency}',
  nothingIn: 'لا شيء بعملة {currency}',
  tapMonthForDays: 'اضغط على شهر لرؤية أيامه.',
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
  dayNumber: 'اليوم {n}',
  tripDay: 'اليوم {day} من {total}',
  planned: 'المخطط',
  spent: 'المصروف',
  overBudget: 'زيادة',
  underBudget: 'أقل',
  budgets: 'الميزانية',
  overallBudget: 'الإجمالي',
  myBudget: 'ميزانيتي',
  budgetAmount: 'المبلغ',
  shareWithGroup: 'مشاركة مع المجموعة',
  budgetPrivate: 'لي فقط',
  saveBudget: 'حفظ',
  clearBudget: 'مسح',
  budgetLeft: 'المتبقي',
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
    loading: 'جارٍ التحميل…',
    close: 'إغلاق',
    cancel: 'إلغاء',
    save: 'حفظ',
    edit: 'تعديل',
    remove: 'إزالة',
    delete: 'حذف',
    share: 'مشاركة',
    done: 'تم',
    about: 'حول {title}',
    guest: 'ضيف',
    name: 'الاسم',
    yourName: 'اسمك',
    emailOrPhone: 'البريد الإلكتروني أو رقم الهاتف',
    notFound: 'غير موجود',
    goBack: 'العودة',
    ok: 'حسنًا',
    tooFastMoment: 'محاولات كثيرة دفعة واحدة. انتظر قليلًا ثم أعد المحاولة.',
    tooFastLater: 'محاولات كثيرة دفعة واحدة. أعد المحاولة بعد قليل.',
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
  theme: {
    title: 'المظهر',
    light: 'فاتح',
    dark: 'داكن',
    lightHint: 'خلفية الخزامى الفاتحة.',
    darkHint: 'أرفق بالعينين ليلًا.',
    currently: 'حاليًا {scheme}',
    followingPhone: 'يتبع هاتفك',
    footnote: 'اتباع هاتفك يجعل التطبيق يصير داكنًا حين يصير هاتفك داكنًا.',
  },
  sync: {
    title: 'المزامنة عبر',
    wifi: 'واي‑فاي فقط',
    wifiHint: 'المزامنة عبر واي‑فاي فقط. لا تستهلك بيانات الجوال أبدًا.',
    cellular: 'بيانات الجوال فقط',
    cellularHint: 'المزامنة عبر بيانات الجوال فقط، وليس واي‑فاي.',
    both: 'واي‑فاي وبيانات الجوال',
    bothHint: 'المزامنة عبر أي اتصال متاح.',
    footnote: 'تُحفظ التغييرات دائمًا على هاتفك. هذا يحدد فقط متى تغادره.',
    selected: 'محدَّد',
    waitingWifi: 'محفوظ — بانتظار واي‑فاي للمزامنة.',
    waitingCellular: 'محفوظ — بانتظار بيانات الجوال للمزامنة.',
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
  devices: {
    title: 'الأجهزة',
    intro:
      'الخطة المجانية تشمل جهازين في وقت واحد. الجهاز الذي لم تفتحه منذ فترة يتوقف عن العدّ من تلقاء نفسه.',
    thisDevice: 'هذا الجهاز',
    signedOut: 'تم تسجيل الخروج',
    lastActive: 'آخر نشاط {when}',
    signOutOthers: 'تسجيل الخروج من كل الأجهزة الأخرى',
    signOutOthersHint:
      'يُسجّل الخروج من كل جهاز عدا هذا الجهاز. ستُطلب منها تسجيل الدخول في المرة القادمة.',
    signedOutOthers: {
      zero: 'تم تسجيل الخروج من {n} جهاز آخر.',
      one: 'تم تسجيل الخروج من جهاز آخر.',
      two: 'تم تسجيل الخروج من جهازين آخرين.',
      few: 'تم تسجيل الخروج من {n} أجهزة أخرى.',
      many: 'تم تسجيل الخروج من {n} جهازًا آخر.',
      other: 'تم تسجيل الخروج من {n} جهاز آخر.',
    },
    onlyThisDevice: 'هذا هو الجهاز الوحيد المسجّل الدخول.',
    historyNote: 'يتم عرض آخر ثلاثة أشهر.',
    row: 'الأجهزة',
    rowHint: 'اطّلع على أماكن تسجيل دخولك',
    gateTitle: 'مسجّل الدخول على أجهزة أكثر من اللازم',
    gateBody:
      'الخطة المجانية تشمل جهازين في وقت واحد، وهذا الحساب تجاوز ذلك. سجّل الخروج من الأجهزة الأخرى لمواصلة استخدام باقي على هذا الجهاز.',
    gateAction: 'تسجيل الخروج من الأجهزة الأخرى',
    gateDismiss: 'ليس الآن',
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
    sectionProfile: 'الملف الشخصي',
    sectionBaaki: 'باقي',
    sectionSettings: 'الإعدادات',
    sectionSecurity: 'الأمان',
    youRowHint: 'اسمك وكيف تظهر للآخرين',
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
    themeRow: 'المظهر',
    languageFollowingPhone: 'يتبع هاتفك — {language}',
    languageRestartHint: '{language} · أعد فتح باقي لعكس الاتجاه',
    languageRestartHintBack: '{language} · أعد فتح باقي لإعادة الاتجاه',
    restartTitle: 'أغلق باقي وافتحه من جديد',
    restartNow: 'أعد تشغيل باقي',
    restartNowMirror: 'هل نعيد تشغيل باقي الآن لعكس اتجاه الواجهة؟',
    restartNowUnmirror: 'هل نعيد تشغيل باقي الآن لإعادة الاتجاه؟',
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
    emailSection: 'عبر البريد',
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
    phonePlaceholder: '{code} 50 123 4567',
    codeEmailed: 'أدخل الرمز المكوّن من ستة أرقام الذي أرسلناه إلى بريدك',
    codeTexted: 'أدخل الرمز المكوّن من ستة أرقام الذي أرسلناه برسالة نصية',
    verificationCode: 'رمز التحقق',
    confirm: 'تأكيد',
    sendCodeEmail: 'أرسل لي رمزًا',
    sendCodePhone: 'أرسل الرمز برسالة',
    useDifferent: 'استخدم غيره',
    added: 'تمت الإضافة. يمكنك الآن تسجيل الدخول به على هاتف آخر.',
    signInMethodsTitle: 'طرق تسجيل الدخول',
    signInMethodsBody: 'اربط حسابًا لتتمكن من تسجيل الدخول به في المرة القادمة، على أي هاتف.',
    link: 'ربط',
    linked: 'مرتبط',
    footnote:
      'لا يطلب باقي هذا ليسمح لك بالدخول، ولا يشاركه مع أحد في مجموعاتك. يرى الناس الاسم الذي تختاره، لا غير.',
    gateTitle: 'احتفظ بحسابك للمتابعة',
    gateGroupBody:
      'أنت في مجموعة كضيف. أضف بريدًا إلكترونيًا أو هاتفًا أو مزوّدًا لبدء مجموعات أخرى أو الانضمام إليها — كل ما أدخلته يبقى معك.',
    gateExpiredBody:
      'انتهت فترتك كضيف، لذا التطبيق للقراءة فقط الآن. أضف طريقة لتسجيل الدخول لمواصلة الإضافة — مجموعاتك ومصروفاتك كلها لا تزال هنا.',
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
    useAPassword: 'البريد الإلكتروني أو كلمة المرور',
    phoneNumber: 'رقم الهاتف',
    countryCodeHint:
      'ابدأ برمز بلدك. لا يفترض باقي أبدًا رمزًا بعينه — فالأرقام الأجنبية تظهر في السفر تحديدًا.',
    sendCode: 'أرسل الرمز',
    codeSentTo: 'أُرسل الرمز إلى {value}',
    verify: 'تحقّق',
    differentNumber: 'استخدم رقمًا آخر',
    identifier: 'البريد الإلكتروني أو رقم الهاتف',
    identifierPlaceholder: 'alex@example.com أو ‎{code}…',
    password: 'كلمة المرور',
    passwordHint: 'ثمانية أحرف أو أكثر. عبارة تتذكّرها خير من لغز لن تتذكّره.',
    addToAccount: 'أضف هذا إلى حسابي',
    createAccount: 'إنشاء حساب',
    signInAction: 'تسجيل الدخول',
    switchToSignIn: 'لديك حساب بالفعل؟ سجّل الدخول',
    switchToSignUp: 'جديد هنا؟ أنشئ حسابًا',
    continueGoogle: 'المتابعة عبر Google',
    signInGoogle: 'تسجيل الدخول عبر Google',
    continueApple: 'المتابعة عبر Apple',
    signInApple: 'تسجيل الدخول عبر Apple',
    orSignInWith: 'أو سجّل الدخول عبر',
    continueGuest: 'المتابعة كضيف',
    guestFootnote: 'كل ما أضفته يبقى كما هو تمامًا. هذا يضيف فقط طريقة للعودة وتسجيل الدخول.',
    memberFootnote:
      'يحتفظ حساب الضيف بكل شيء على هذا الجهاز حتى تضيف طريقة لتسجيل الدخول. دفترك ليس رهينة أبدًا.',
    couldNotSignIn: 'تعذّر تسجيل الدخول. حاول مرة أخرى.',
    restartToMirror: 'أغلق باقي وافتحه مرة واحدة لعكس اتجاه الواجهة.',
    restartToUnmirror: 'أغلق باقي وافتحه مرة واحدة لإعادة اتجاه الواجهة.',
  },
  tabs: {
    guestBanner: 'أنت تستخدم باقي كضيف',
    guestBannerBody:
      'لا شيء ناقص — كل ما تدخله محفوظ وهو ملكك. أضف بريدًا إلكترونيًا أو رقم هاتف متى أردت الوصول إليه من هاتف آخر.',
    guestDaysLeft: 'بقي {days} أيام كضيف — سجّل بعدها للمتابعة.',
    guestReadOnly: 'انتهت فترتك كضيف — التطبيق للقراءة فقط. سجّل لمواصلة الإضافة.',
    addYourDetails: 'أضف بياناتك',
    loadingGroups: 'جارٍ تحميل مجموعاتك…',
    noGroups: 'لا مجموعات بعد',
    noGroupsBody:
      'ابدأ واحدة لرحلة أو لشقة أو لكما أنتما. إضافة المصروفات مجانية وبلا حدود، دائمًا.',
    activityEmptyBody: 'كل مصروف وتعديل وحذف وتسوية يصل إلى هنا — لكل من في المجموعة.',
    quickActions: 'إجراءات سريعة',
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
  dashHero: {
    scanTitle: 'صوّر الإيصال',
    scanBody: 'امسح الفاتورة وتُملأ البنود تلقائيًا — قسّمها في ثوانٍ.',
    scanCta: 'مسح',
    inviteTitle: 'سوّوا الحساب معًا',
    inviteBody: 'أضف من تتشارك معهم النفقات وابقوا جميعًا على حساب متوازن.',
    inviteCta: 'إضافة شخص',
  },
  mergePeople: {
    entry: 'دمج الأشخاص',
    title: 'دمج الأشخاص',
    subtitle: 'اختر الضيوف الذين هم الشخص نفسه. تُجمع أرصدتهم تحت اسم واحد.',
    empty: 'لا يوجد ضيوف للدمج — يمكن دمج من ليس لديهم حساب Baaki فقط.',
    nameLabel: 'اسم الشخص المدمج',
    namePlaceholder: 'مثال: رافي',
    warningTitle: 'لا يمكن التراجع عن هذا',
    warningBody: 'تُجمع أرصدتهم المنفصلة في شخص واحد نهائيًا. لا توجد طريقة لفصلهم مرة أخرى.',
    cta: 'دمج',
    selected: { one: 'تم اختيار شخص واحد', other: 'تم اختيار {n} أشخاص' },
    merged: 'تم الدمج في {name}',
    errorTooFew: 'اختر شخصين على الأقل للدمج.',
    errorNotMergeable: 'يمكنك دمج الضيوف الذين تشاركهم مجموعة فقط.',
    errorNameRequired: 'أعطِ الشخص المدمج اسمًا.',
    errorGeneric: 'تعذّر الدمج. يرجى المحاولة مرة أخرى.',
  },
  groupPhoto: {
    paidHint: 'صور المجموعة ميزة Plus. اختر أيقونة، أو قم بالترقية لإضافة صورة.',
  },
  inbox: {
    title: 'صندوق الوارد',
    nothingYetBody:
      'التذكيرات وتأكيدات التسوية وكل ما يخبرك به باقي يتجمّع هنا — حتى حين لا يصل الإشعار إلى هاتفك.',
    recent: 'الأحدث',
  },
  captures: {
    title: 'الالتقاطات',
    captureCta: 'التقط مصروفًا',
    newTitle: 'التقط مصروفًا',
    emptyTitle: 'لا شيء ملتقط بعد',
    emptyBody:
      'التقط المصروف لحظة حدوثه — المبلغ، ملاحظة، صورة الفاتورة — وقرّر لاحقًا إلى أي مجموعة ينتمي.',
    amount: 'المبلغ',
    description: 'ما هذا؟',
    descriptionPlaceholder: 'قهوة، تاكسي، بقالة…',
    category: 'لماذا؟',
    date: 'التاريخ',
    receipt: 'الإيصال',
    addReceipt: 'أضف إيصالًا',
    reading: 'جارٍ القراءة…',
    notSynced: 'لم تتم المزامنة بعد',
    assign: 'أسنِد إلى مجموعة',
    assignTitle: 'أسنِد إلى مجموعة',
    assignBody: 'اختر المجموعة التي ينتمي إليها. يمكنك تحديد من دفع وكيفية التقسيم بعد ذلك.',
    noGroups: 'ليست لديك مجموعات بعد. أنشئ واحدة أولًا ثم أسنِد هذا إليها.',
    delete: 'حذف',
    deleteConfirm: 'حذف هذا الالتقاط؟ سيُحذف المبلغ وصورة الفاتورة معه.',
    unassigned: 'غير مُسنَد',
    unassignedBody: {
      zero: 'لا التقاطات تنتظر مجموعة',
      one: 'التقاط واحد ينتظر مجموعة',
      two: 'التقاطان ينتظران مجموعة',
      few: '{n} التقاطات تنتظر مجموعة',
      many: '{n} التقاطًا تنتظر مجموعة',
      other: '{n} التقاط ينتظر مجموعة',
    },
    itemizedTitle: 'مفصّل',
    itemCount: {
      one: 'عنصر واحد',
      two: 'عنصران',
      few: '{n} عناصر',
      many: '{n} عنصرًا',
      other: '{n} عنصر',
    },
    couldNotRead: 'تعذّر قراءة هذا الإيصال — أدخل المبلغ بنفسك.',
    savedOnDevice: 'محفوظ على هذا الجهاز',
    save: 'حفظ',
  },
  backup: {
    title: 'نسخ الإيصالات احتياطيًا',
    subtitle: 'احتفظ بالإيصالات الممسوحة على سحابتك الخاصة',
    primaryTitle: 'انسخ الإيصالات احتياطيًا إلى',
    primaryBody:
      'تُحفظ الإيصالات الممسوحة على هذا الجهاز وتُنسخ إلى السحابة التي تختارها. لا تصل أبدًا إلى خوادم Baaki.',
    off: 'إيقاف',
    connect: 'اتصال',
    disconnect: 'قطع الاتصال',
    connected: 'متصل',
    notConfigured: 'غير مُهيّأ في هذه النسخة',
    networkTitle: 'الرفع عبر',
    wifiOnly: 'واي‑فاي فقط',
    wifiAndData: 'واي‑فاي وبيانات الجوال',
    pending: {
      zero: 'لا إيصالات بانتظار النسخ',
      one: 'إيصال واحد بانتظار النسخ الاحتياطي',
      two: 'إيصالان بانتظار النسخ',
      few: '{n} إيصالات بانتظار النسخ',
      many: '{n} إيصالًا بانتظار النسخ',
      other: '{n} إيصال بانتظار النسخ',
    },
    allBackedUp: 'تم نسخ جميع الإيصالات احتياطيًا',
    privacyNote: 'تبقى الصورة على هاتفك وسحابتك المختارة. لا يرى Baaki سوى المبلغ الذي تحفظه.',
  },
  group: {
    notFound: 'المجموعة غير موجودة',
    notFoundBody: 'ربما أُرشفت، أو لم تعد عضوًا فيها.',
    notFoundArchived: 'ربما أُرشفت.',
    loading: 'جارٍ التحميل…',
    settings: 'إعدادات المجموعة',
    more: 'المزيد',
    mismatch: 'الأرصدة بحاجة إلى تحديث',
    mismatchBody:
      'هذا الجهاز والخادم لا يتفقان على أرصدة هذه المجموعة. اسحب للتحديث؛ وإن استمر الأمر فالدفتر بالأسفل هو المرجع.',
    confirmReceived: 'أكّد الاستلام',
    saysTheyPaidYou: 'يقول {name} إنه دفع لك',
    autoConfirms: 'يتأكد تلقائيًا خلال 7 أيام إن لم يردّ أحد.',
    hideDeleted: 'إخفاء المحذوف',
    showDeleted: 'إظهار المحذوف',
    activityEmptyBody: 'كل ما يحدث هنا يظهر في هذا السجل.',
    photoUpdated: 'تم تحديث الصورة',
    nameOptional: 'الاسم (اختياري)',
    groupName: 'اسم المجموعة',
    saveName: 'حفظ الاسم',
    chooseIcon: 'اختر أيقونة',
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
    archivedTitle: 'المجموعات المؤرشفة',
    archivedEmpty: 'لا شيء في الأرشيف',
    archivedEmptyBody: 'المجموعات التي تؤرشفها تظهر هنا، جاهزة للاستعادة.',
    unarchive: 'إلغاء الأرشفة',
    archivedOn: 'أُرشفت في {date}',
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
    role: 'الدور',
    makeAdmin: 'تعيين كمشرف',
    removeAdmin: 'إزالة الإشراف',
    adminNote: 'يمكن للمشرفين تعديل المجموعة وإدارة الأعضاء وتحديد الميزانية الإجمالية.',
    adminNeedsAccount: 'لم ينضم بعد. المشرف يجب أن يكون عضوًا لديه حساب.',
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
    usesBadge: '{count} استخدامات',
    shareMessage:
      'انضم إلى {group} على Baaki لتقسيم المصروفات — لا حاجة إلى تطبيق أو حساب للبدء: {link}',
    emailSubject: 'انضم إلى {group} على Baaki',
    mintMistakeNote:
      'أنشأت رابطًا بالخطأ؟ أنشئ رابطًا جديدًا — يظل الرابط القديم صالحًا حتى ينتهي، لذا شارك فقط الروابط التي تقصدها.',
    hideContacts: 'إخفاء جهات الاتصال',
    browseContacts: 'تصفّح جهات اتصالي',
    contacts: 'جهات الاتصال',
    remind: 'ذكّر',
    reminded: 'تم التذكير',
    remindedToday: 'ذُكّر اليوم',
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
    aBill: 'فاتورة',
    splitBillA11y: 'قسّم {merchant} حسب الصنف',
    receiptClaimedNone: {
      zero: 'لا بنود بعد.',
      one: 'بند واحد، لم يطالب به أحد بعد. اضغط ما كان لك.',
      two: 'بندان، لم يطالب بهما أحد بعد. اضغط ما كان لك.',
      few: '{n} بنود، لم يطالب بها أحد بعد. اضغط ما كان لك.',
      many: '{n} بندًا، لم يطالب بها أحد بعد. اضغط ما كان لك.',
      other: '{n} بند، لم يطالب به أحد بعد. اضغط ما كان لك.',
    },
    receiptClaimedSome: 'تمّت المطالبة بـ {claimed} من {items} بندًا. اضغط ما كان لك.',
    scanReadItemsCta: {
      zero: 'لم يُقرأ أي بند',
      one: 'قرأ بندًا واحدًا — قسّمه حسب الصنف بدلاً من ذلك',
      two: 'قرأ بندين — قسّمهما حسب الصنف بدلاً من ذلك',
      few: 'قرأ {n} بنود — قسّمها حسب الصنف بدلاً من ذلك',
      many: 'قرأ {n} بندًا — قسّمها حسب الصنف بدلاً من ذلك',
      other: 'قرأ {n} بند — قسّمها حسب الصنف بدلاً من ذلك',
    },
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
    disputed: 'متنازع عليه',
    untitled: 'بلا عنوان',
    paidByName: 'دفع {name}',
    editedTimes: {
      zero: 'لم يُعدّل',
      one: 'عُدّل مرة واحدة',
      two: 'عُدّل مرتين',
      few: 'عُدّل {n} مرات',
      many: 'عُدّل {n} مرة',
      other: 'عُدّل {n} مرة',
    },
    inCount: {
      zero: 'في {n} مصروف',
      one: 'في مصروف واحد',
      two: 'في مصروفين',
      few: 'في {n} مصروفات',
      many: 'في {n} مصروفًا',
      other: 'في {n} مصروف',
    },
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
    peopleSplitting: {
      one: 'يتقاسم شخص واحد المصروفات هنا',
      other: 'يتقاسم {n} أشخاص المصروفات هنا',
    },
    peopleCount: { one: 'شخص واحد', other: '{n} أشخاص' },
    contactsAdded: 'أُضيف {count}. اختر شخصاً آخر، أو ارجع.',
    couldNotAdd: 'تعذّرت إضافة {names}.',
    couldNotAddSome: 'تعذّرت إضافة الجميع. {reason}',
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
    notSentYet: 'لم يُرسل بعد',
    offlineWithCount: {
      zero: 'دون اتصال — لا تغييرات',
      one: 'دون اتصال — تغيير واحد محفوظ على هذا الهاتف',
      two: 'دون اتصال — تغييران محفوظان على هذا الهاتف',
      few: 'دون اتصال — {n} تغييرات محفوظة على هذا الهاتف',
      many: 'دون اتصال — {n} تغييرًا محفوظًا على هذا الهاتف',
      other: 'دون اتصال — {n} تغيير محفوظ على هذا الهاتف',
    },
    cantReachServer: {
      zero: 'تعذّر الوصول إلى الخادم',
      one: 'تعذّر الوصول إلى الخادم — تغيير واحد محفوظ هنا في انتظار الإرسال',
      two: 'تعذّر الوصول إلى الخادم — تغييران محفوظان هنا في انتظار الإرسال',
      few: 'تعذّر الوصول إلى الخادم — {n} تغييرات محفوظة هنا في انتظار الإرسال',
      many: 'تعذّر الوصول إلى الخادم — {n} تغييرًا محفوظًا هنا في انتظار الإرسال',
      other: 'تعذّر الوصول إلى الخادم — {n} تغيير محفوظ هنا في انتظار الإرسال',
    },
    syncingCount: {
      zero: 'جارٍ الإرسال…',
      one: 'جارٍ إرسال تغيير واحد…',
      two: 'جارٍ إرسال تغييرين…',
      few: 'جارٍ إرسال {n} تغييرات…',
      many: 'جارٍ إرسال {n} تغييرًا…',
      other: 'جارٍ إرسال {n} تغيير…',
    },
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
    dictationErrors: {
      notAllowed: 'يحتاج باقي إلى إذن لاستخدام الميكروفون. يمكنك تفعيله من الإعدادات.',
      noSpeech: 'لم يُلتقط أي شيء. انقر الميكروفون وتحدّث مرة أخرى.',
      audioBusy: 'الميكروفون مشغول. أغلق أي تطبيق آخر يسجّل وحاول مرة أخرى.',
      network: 'يحتاج التعرّف على الكلام إلى اتصال على هذا الهاتف. اكتب الملاحظة بدلًا من ذلك.',
      languageNotSupported:
        'لا يستطيع هذا الهاتف التعرّف على تلك اللغة بعد. اكتب الملاحظة بدلًا من ذلك.',
      stopped: 'توقّف الإملاء. اكتب الملاحظة بدلًا من ذلك.',
    },
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
    withLabel: 'مع',
    settleNoDetailsTitle: 'لا توجد تفاصيل {rail} بعد',
    settleNoDetailsBody:
      'لم يُضِف {name} كيفية استلامه للمدفوعات. سوِّ نقدًا، أو اطلب منه إضافتها.',
    settleRailFallback: 'الدفع',
    settlePayTitle: 'ادفع إلى {name}',
    settlePayBody: '{rail}\n{handle}\n\nثم عُد وسجِّل ذلك.',
    settleSendTo: 'أرسل إلى',
    recordYes: 'نعم، سجِّلها',
    recordNo: 'لا',
    recordIt: 'سجِّلها',
    noReasonGiven: 'لم يُذكر سبب',
    disputeStands:
      'لم يتغيّر شيء بعد — يبقى نصيبك قائمًا حتى يُصحَّح المصروف. هذا مقصود: نصيب يستطيع أي شخص إسقاطه بمفرده لن يكون دفترًا.',
    neverMind: 'لا بأس، الأمر جيّد',
    whatsWrongWithIt: 'ما الخطأ فيه؟',
    somethingsWrong: 'هناك خطأ ما',
    tripDatesTitle: 'تواريخ الرحلة',
    aboutTripDates: 'حول تواريخ الرحلة',
    tripDatesBody:
      'أثناء الرحلة، يتلقّى الجميع تذكيرًا بإضافة ما أنفقوه — عند الإفطار عن الأمس، وفي نهاية اليوم عن اليوم. لا يُسأل أحد عن يوم سبق أن أضافه.',
    bankRateNote: 'سعر بنكك، شاملًا الهامش — هذا ما يقوله كشف حسابك.',
    listening: 'يستمع…',
    whereSettle: 'أين تُسوّي هذه المجموعة حساباتها؟',
    youHaveVersion: 'لديك {installed}',
    versionAvailable: ' · {latest} متاح',
    gotIt: 'حسنًا',
    copied: 'تم النسخ',
    tapToCopy: 'اضغط الزر للنسخ',
    insightsLiveNote:
      'المصروفات الحيّة فقط — المصروف المُعدَّل يُحتسب بما يقوله الآن، والمحذوف لا يُحتسب إطلاقًا. لا تُحوَّل المبالغ بين العملات أبدًا.',
    nameAloneBody:
      'الاسم وحده يكفي — لا يحتاج أحد إلى التطبيق أو بريد إلكتروني ليكون جزءًا من التقسيم. العنوان يعني فقط أنه يمكنك إرسال الرابط إليه. وعندما ينضمّون لاحقًا يمكنهم المطالبة بكل ما سُجِّل باسمهم.',
    noUpiYet: 'لا يوجد معرّف UPI بعد',
    csvCurrencyMismatch:
      'هذا الملف بعملة {fileCur} وهذه المجموعة تحتفظ بأموالها بعملة {groupCur}. استيراده يحتاج إلى سعر لكل صف، والملف لا يحمل ذلك — ابدأ بدلًا من ذلك مجموعة بعملة {fileCur}.',
    rateFetchFailedSuffix: ' — يمكنك إدخال السعر يدويًا بدلًا من ذلك',
    settlesInHint: 'تُسوّى حسابات هذه المجموعة بعملة {currency}',
    howDoYouKnowRate: 'تُسوّى حسابات هذه المجموعة بعملة {currency}. كيف عرفت سعر الصرف؟',
    todaysRate: 'سعر اليوم',
    statementAmountLabel: 'المبلغ في كشف حسابك، بعملة {currency}',
    amountChargedIn: 'المبلغ المخصوم بعملة {currency}',
    fxOneEquals: '1 {from} = ? {to}',
    fxRateFromTo: 'السعر من {from} إلى {to}',
    convertedApprox: '≈ {amount} بعملة {currency}',
    rateStoredNote:
      'السعر {rate} من {source}. يُحفظ مع المصروف، لذا يُحوَّل بالطريقة نفسها لاحقًا.',
    rateSourceEcb: 'البنك المركزي الأوروبي',
    rateSourceImplied: 'كشف حسابك',
    rateSourceYou: 'أنت',
    noRateNote:
      'يُحفظ المصروف حتى بدون سعر — يبقى بعملة {currency}، وتحتفظ المجموعة برصيد {currency} منفصل.',
    thinkThisOff: {
      zero: 'لا أحد يظن أن هذا غير صحيح',
      one: 'يظن أحدهم أن هذا غير صحيح',
      two: 'يظن شخصان أن هذا غير صحيح',
      few: 'يظن {n} أشخاص أن هذا غير صحيح',
      many: 'يظن {n} شخصًا أن هذا غير صحيح',
      other: 'يظن {n} شخص أن هذا غير صحيح',
    },
    sending: 'جارٍ الإرسال…',
    tellThem: 'أخبرهم',
    versionStoppedBody:
      'لم يعد بإمكان هذه النسخة التواصل مع باقي، لذا أُوقفت بدلًا من أن تعرض عليك أرقامًا قد تكون خاطئة.',
    newBaakiOut: 'صدر إصدار جديد من باقي',
    baakiVersionOut: 'صدر باقي {latest}',
  },
  smsImport: {
    title: 'استيراد من الرسائل',
    howTo:
      'افتح تطبيق الرسائل، واختر رسائل البنك الخاصة بهذه الرحلة، وانسخها والصقها هنا. يقرأها باقي على هذا الهاتف — ولا يُرسل أي شيء إلى أي مكان حتى تؤكّد مصروفًا.',
    whyNotAutomatic:
      'لا يستطيع باقي قراءة صندوق رسائلك من تلقاء نفسه. لا يمنح iPhone هذه الصلاحية لأي تطبيق، وفي أندرويد تقتصر على التطبيق الذي تستخدمه للرسائل.',
    messagesSection: 'الرسائل',
    pasteLabel: 'ألصق رسائل البنك',
    pastePlaceholder: 'ألصق هنا.\n\nاترك سطرًا فارغًا بين كل رسالة وأخرى.',
    nothingPasted: 'لم يُلصق شيء بعد',
    messageCount: {
      zero: 'لا رسائل',
      one: 'رسالة واحدة',
      two: 'رسالتان',
      few: '{n} رسائل',
      many: '{n} رسالة',
      other: '{n} رسالة',
    },
    paste: 'لصق',
    datesSection: 'بين هذين التاريخين',
    datesNote:
      'لا تُقترح إلا المدفوعات الواقعة داخل هذه المدة، فيبقى باقي صندوق رسائلك خارج المجموعة.',
    from: 'من',
    to: 'إلى',
    last7: 'آخر 7 أيام',
    last30: 'آخر 30 يومًا',
    datePlaceholder: 'YYYY-MM-DD',
    dateFieldLabel: 'تاريخ {label}، سنة شهر يوم',
    foundSection: 'ما وُجد',
    nothingToImport: 'لا شيء للاستيراد',
    nothingLikeAPayment:
      'لم تبدُ أي من تلك الرسائل دفعةً داخل هذه التواريخ. التذكيرات وكلمات المرور لمرة واحدة والأموال الواردة كلها مستبعدة عن قصد.',
    allAnotherCurrency: 'كل دفعة وُجدت كانت بعملة أخرى.',
    cardPayment: 'دفعة بالبطاقة',
    selected: 'محدَّد',
    notSelected: 'غير محدَّد',
    checkThis: 'تحقّق من هذا',
    otherCurrencyNote: {
      zero: 'لا مدفوعات بعملة أخرى.',
      one: 'دفعة واحدة كانت بعملة أخرى. أضفها يدويًا — فالرسالة لا تذكر السعر الذي حُسب عليك، وهذه المجموعة تحفظ حسابها بـ {currency}.',
      two: 'دفعتان كانتا بعملة أخرى. أضفهما يدويًا — فالرسائل لا تذكر السعر الذي حُسب عليك، وهذه المجموعة تحفظ حسابها بـ {currency}.',
      few: '{n} مدفوعات كانت بعملة أخرى. أضفها يدويًا — فالرسائل لا تذكر السعر الذي حُسب عليك، وهذه المجموعة تحفظ حسابها بـ {currency}.',
      many: '{n} دفعة كانت بعملة أخرى. أضفها يدويًا — فالرسائل لا تذكر السعر الذي حُسب عليك، وهذه المجموعة تحفظ حسابها بـ {currency}.',
      other:
        '{n} دفعة كانت بعملة أخرى. أضفها يدويًا — فالرسائل لا تذكر السعر الذي حُسب عليك، وهذه المجموعة تحفظ حسابها بـ {currency}.',
    },
    whoPaidSection: 'من دفع',
    whoPaidNote:
      'رسالة البنك تقول ما خرج من حسابك، لا من كان حاضرًا. تُقسَّم هذه بالتساوي بين كل أعضاء المجموعة — ويمكنك تغيير أي منها بعد ذلك.',
    addedCount: {
      zero: 'لم يُضف أي مصروف.',
      one: 'أُضيف مصروف واحد. إنه محفوظ على هذا الهاتف وسيُزامَن عند توفّر اتصال.',
      two: 'أُضيف مصروفان. إنهما محفوظان على هذا الهاتف وسيُزامَنان عند توفّر اتصال.',
      few: 'أُضيفت {n} مصاريف. إنها محفوظة على هذا الهاتف وستُزامَن عند توفّر اتصال.',
      many: 'أُضيف {n} مصروفًا. إنها محفوظة على هذا الهاتف وستُزامَن عند توفّر اتصال.',
      other: 'أُضيف {n} مصروف. إنها محفوظة على هذا الهاتف وستُزامَن عند توفّر اتصال.',
    },
    adding: 'جارٍ الإضافة…',
    nothingSelected: 'لم يُحدَّد شيء',
    addCount: {
      zero: 'لا شيء لإضافته',
      one: 'أضف مصروفًا واحدًا',
      two: 'أضف مصروفين',
      few: 'أضف {n} مصاريف',
      many: 'أضف {n} مصروفًا',
      other: 'أضف {n} مصروف',
    },
    readMessages: 'اقرأ رسائلي',
    reading: 'جارٍ القراءة…',
    readOnAndroid:
      'على أندرويد، يمكن لـ Baaki قراءة رسائل البنك ضمن هذه التواريخ نيابةً عنك. يطلب الإذن أولًا، ويقرأها على هذا الهاتف، ولا يُرسل أي شيء إلى أي مكان حتى تؤكّد المصروف.',
    readCount: {
      zero: 'لم تُقرأ أي رسالة من صندوق الوارد.',
      one: 'قُرئت رسالة واحدة من صندوق الوارد.',
      two: 'قُرئت رسالتان من صندوق الوارد.',
      few: 'قُرئت {n} رسائل من صندوق الوارد.',
      many: 'قُرئت {n} رسالة من صندوق الوارد.',
      other: 'قُرئت {n} رسالة من صندوق الوارد.',
    },
    readNothing: 'لا توجد رسائل بنكية في هذه التواريخ.',
    permissionDenied: 'يحتاج Baaki إلى إذنك لقراءة الرسائل. يمكنك بدلًا من ذلك لصقها بالأسفل.',
    permissionBlocked:
      'الوصول إلى الرسائل مُعطَّل لـ Baaki. فعِّله من الإعدادات › التطبيقات › Baaki › الأذونات، أو الصق الرسائل بالأسفل.',
    readUnsupported: 'قراءة الرسائل تعمل على أندرويد فقط. الصقها بالأسفل بدلًا من ذلك.',
    readUnavailable: 'هذا الإصدار لا يستطيع قراءة الرسائل. الصقها بالأسفل.',
    readFailed: 'تعذّرت قراءة رسائلك. الصقها بالأسفل.',
    permissionRationale: {
      title: 'قراءة رسائل البنك',
      message:
        'يقرأ باقي رسائل مدفوعات البنك على هذا الهاتف ليقترح مصروفات رحلتك. تبقى الرسائل على هاتفك — لا يُرسل أي شيء إلى أي مكان حتى تؤكّد مصروفًا.',
      allow: 'السماح',
      notNow: 'ليس الآن',
    },
    dateNotInMessage: 'التاريخ غير مذكور في الرسالة',
  },
  itemize: {
    title: 'التقسيم حسب الصنف',
    notAMember: 'لست عضوًا في هذه المجموعة',
    invalidTaxOrTip: 'أدخل مبلغًا صالحًا للضريبة والبقشيش.',
    defaultDescription: 'فاتورة بالأصناف',
    sharedNow: 'صار بإمكان كل أعضاء المجموعة رؤية هذه الفاتورة. اضغط على الأصناف التي تناولتها.',
    splittingTogether: 'نقسّمها معًا',
    splittingTogetherNote:
      'كل أعضاء المجموعة ينظرون إلى هذه الأصناف. اضغط على ما تناولته — يرونه وأنت تفعله. لم يعد بالإمكان تغيير الأصناف، لأن كل اختيار مثبّت على صنفه.',
    everyoneHasAPhone: 'هل مع كل من على الطاولة هاتف؟',
    handOverNote:
      'سلّم هذه الأصناف للمجموعة ليضغط كلٌّ على ما تناوله من هاتفه. تحقّق من الأصناف أولًا — فبمجرد أن يختار أحدهم صنفًا تثبت القائمة.',
    sharing: 'جارٍ المشاركة…',
    splitTogether: 'التقسيم معًا',
    whatWasTheBillFor: 'الفاتورة على ماذا؟',
    descriptionPlaceholder: 'عشاء في المطعم',
    descriptionLabel: 'وصف الفاتورة',
    addALine: 'أضف صنفًا',
    itemPlaceholder: 'برياني',
    itemName: 'اسم الصنف',
    itemAmount: 'مبلغ الصنف',
    unclaimed: 'لم يطالب أحد بهذا',
    splitWays: {
      zero: 'لا أحد',
      one: 'لشخص واحد',
      two: 'مقسوم بين اثنين',
      few: 'مقسوم بين {n} أشخاص',
      many: 'مقسوم بين {n} شخصًا',
      other: 'مقسوم بين {n} شخص',
    },
    taxAndTipNote: 'الضريبة والإكرامية — تُوزَّع بنسبة ما طلبه كل شخص',
    taxRow: 'الضريبة / الخدمة',
    tipRow: 'الإكرامية',
    taxAmount: 'مبلغ الضريبة',
    tipAmount: 'مبلغ الإكرامية',
    total: 'المجموع',
    someone: 'أحدهم',
    waitingForLines: 'في انتظار أصناف هذه الفاتورة.',
    addTheLines: 'أضف أصناف الفاتورة واضغط على من تناول ماذا.',
    stillUnclaimed: {
      zero: 'لا أصناف بلا مطالب.',
      one: 'صنف واحد بلا مطالب — لا أحد يدفع ثمن طبق لم يطلبه.',
      two: 'صنفان بلا مطالب — لا أحد يدفع ثمن طبق لم يطلبه.',
      few: '{n} أصناف بلا مطالب — لا أحد يدفع ثمن طبق لم يطلبه.',
      many: '{n} صنفًا بلا مطالب — لا أحد يدفع ثمن طبق لم يطلبه.',
      other: '{n} صنف بلا مطالب — لا أحد يدفع ثمن طبق لم يطلبه.',
    },
    tapWhoHadEach: 'اضغط على من تناول كل صنف لترى التقسيم.',
    taxAndTipShared: 'تُوزَّع ضريبة وإكرامية بقيمة {amount} بنسبة أصناف كل شخص.',
    scanTitle: 'امسح الفاتورة',
    scanBody:
      'امسح الفاتورة فتظهر البنود مملوءة. تحقّق منها قبل الحفظ — إدخالها يدويًا مجاني دائمًا.',
    scanReadItems: {
      zero: 'لم نقرأ أي بند. تحقّق ثم اضغط لمن كان ماذا.',
      one: 'قرأنا بندًا واحدًا. تحقّق منه ثم اضغط لمن كان ماذا.',
      two: 'قرأنا بندين. تحقّق منهما ثم اضغط لمن كان ماذا.',
      few: 'قرأنا {n} بنود. تحقّق منها ثم اضغط لمن كان ماذا.',
      many: 'قرأنا {n} بندًا. تحقّق منها ثم اضغط لمن كان ماذا.',
      other: 'قرأنا {n} بند. تحقّق منها ثم اضغط لمن كان ماذا.',
    },
    scanCheckLines: 'بعض البنود تحتاج مراجعة قبل الحفظ.',
    carriedOver: 'منقول من المسح. تحقّق من البنود ثم اضغط لمن كان ماذا.',
    notYours: 'هم على Baaki — يضغطون بنودهم بأنفسهم.',
    itemFallback: 'بند {n}',
    removeItem: 'إزالة {label}',
    hadItem: '{name} تناول {label}',
  },
  importLedger: {
    splitwiseTitle: 'استيراد ملف Splitwise',
    ledgerTitle: 'استيراد دفتر',
    splitwiseHowTo: 'في Splitwise، افتح المجموعة واختر Export as spreadsheet، ثم اختر الملف هنا.',
    bringHistory: 'أحضر سجلّك معك',
    free: 'مجانًا',
    ledgerHowTo:
      'من Splitwise: افتح مجموعة ← قائمة ⚙ ← Export as spreadsheet، ثم اختر ملف CSV هنا. من باقي: اختر ملف JSON صدّرته من الإعدادات. كل من ورد اسمه فيه يصبح عضوًا في المجموعة — لا يحتاجون التطبيق، ويمكنهم المطالبة بسجلّهم متى انضمّوا.',
    chooseFile: 'اختر ملفًا',
    chosenFile: 'المختار: {name}',
    chooseDifferentFile: 'اختر ملفًا آخر',
    whichGroup: 'أي مجموعة',
    groupNumber: 'مجموعة {n}',
    whoIsWho: 'من هو من',
    whoIsWhoNote:
      'الملف يذكر أسماء؛ وهذه المجموعة لها أعضاء. لا يُستورد شيء حتى يقابل كل اسمٍ شخصٌ ما.',
    tapANameNote:
      'اضغط على اسم لتقول من يكون هنا. لا يُطابَق أحد بالاسم نيابةً عنك — فقد يحمل شخصان الاسم نفسه فعلًا.',
    addAsNew: 'أضفه كشخص جديد',
    newPerson: 'شخص جديد',
    importedGroup: 'مجموعة مستوردة',
    rowsLeftOut: 'صفوف مستبعدة',
    rowsLeftOutNote:
      'كل ما عداها يُستورد. ذُكرت بأسمائها لتضيفها يدويًا بدل أن تكتشف غيابها لاحقًا.',
    fileWide: 'الملف',
    rowNumber: 'الصف {n}',
    whereItGoes: 'إلى أين يذهب',
    aNewGroup: 'مجموعة جديدة',
    namedAfterFile: 'باسم الملف',
    addToThisGroup: 'أضف إلى هذه المجموعة',
    importing: 'جارٍ الاستيراد…',
    importCount: {
      zero: 'لا شيء لاستيراده',
      one: 'استورد مصروفًا واحدًا',
      two: 'استورد مصروفين',
      few: 'استورد {n} مصاريف',
      many: 'استورد {n} مصروفًا',
      other: 'استورد {n} مصروف',
    },
    chooseWhoIs: 'اختر من يكون {name}',
    chooseWhoArePlural: {
      zero: 'لا أحد',
      one: 'اختر من يكون هذا الشخص',
      two: 'اختر من يكون هذان الشخصان',
      few: 'اختر من يكون {n} أشخاص',
      many: 'اختر من يكون {n} شخصًا',
      other: 'اختر من يكون {n} شخص',
    },
    tapYourNameFirst: 'اضغط أولًا على الاسم الذي يخصّك — وإلا فلن يكون هذا السجلّ لك.',
    imported: 'تم الاستيراد',
    openTheGroup: 'افتح المجموعة',
    importedCount: {
      zero: 'لم يُستورد أي مصروف.',
      one: 'استُورد مصروف واحد. إنه محفوظ على هذا الهاتف وسيُزامَن عند توفّر اتصال.',
      two: 'استُورد مصروفان. إنهما محفوظان على هذا الهاتف وسيُزامَنان عند توفّر اتصال.',
      few: 'استُوردت {n} مصاريف. إنها محفوظة على هذا الهاتف وستُزامَن عند توفّر اتصال.',
      many: 'استُورد {n} مصروفًا. إنها محفوظة على هذا الهاتف وستُزامَن عند توفّر اتصال.',
      other: 'استُورد {n} مصروف. إنها محفوظة على هذا الهاتف وستُزامَن عند توفّر اتصال.',
    },
    expenseCount: {
      zero: 'لا مصاريف',
      one: 'مصروف واحد',
      two: 'مصروفان',
      few: '{n} مصاريف',
      many: '{n} مصروفًا',
      other: '{n} مصروف',
    },
    settlementCount: {
      zero: 'لا تسويات',
      one: 'تسوية واحدة',
      two: 'تسويتان',
      few: '{n} تسويات',
      many: '{n} تسوية',
      other: '{n} تسوية',
    },
    peopleCount: {
      zero: 'لا أشخاص',
      one: 'شخص واحد',
      two: 'شخصان',
      few: '{n} أشخاص',
      many: '{n} شخصًا',
      other: '{n} شخص',
    },
    peopleAdded: {
      zero: 'لم يُضف أحد',
      one: 'أُضيف شخص واحد، في انتظار المطالبة',
      two: 'أُضيف شخصان، في انتظار المطالبة',
      few: 'أُضيف {n} أشخاص، في انتظار المطالبة',
      many: 'أُضيف {n} شخصًا، في انتظار المطالبة',
      other: 'أُضيف {n} شخص، في انتظار المطالبة',
    },
    rowsSkipped: {
      zero: 'لن يُتخطّى أي صف',
      one: 'سيُتخطّى صف واحد',
      two: 'سيُتخطّى صفّان',
      few: 'ستُتخطّى {n} صفوف',
      many: 'سيُتخطّى {n} صفًا',
      other: 'سيُتخطّى {n} صف',
    },
    andMore: '…و{n} غيرها.',
    fromBaakiNote:
      'يأتي كل رصيد بالفلس الواحد، بما في ذلك التسويات. وما لا يأتي: سجلّ تعديلات كل مصروف، وأي المصاريف طُبّقت عليها دفعة سابقة. ولا يغيّر أيٌّ منهما ما على أحد.',
    fromSplitwiseNote:
      'تأتي الأرصدة بالضبط. أما من دفع فلا: ملف Splitwise يسجّل فقط كم ارتفع أو انخفض كل شخص في صفٍّ ما، وكثير من الدافعين المختلفين يعطون النتيجة نفسها. كل مصروف مستورد يُوسم، ويمكنك تصحيح أي منها.',
    otherCurrenciesNote:
      'المبالغ أدناه هي مبالغ {currency}. وتأتي {others} أيضًا، ولا تُحوَّل أبدًا.',
    noGroupsInFile: 'لا توجد مجموعات في ذلك الملف لاستيرادها.',
    couldNotFindYou: 'تعذّر العثور عليك في تلك المجموعة. افتحها وحاول مرة أخرى.',
  },
  pickers: {
    contactsDenied:
      'لا يستطيع باقي رؤية جهات اتصالك. ما زال بإمكانك إضافة أشخاص بكتابة اسم أو بريد أو رقم — لا شيء في المجموعة يحتاج دفتر عناوينك.',
    openSettings: 'افتح الإعدادات',
    contactsUnavailable:
      'تعذّر على باقي قراءة دفتر العناوين على هذا الهاتف. لا خلل في أذوناتك — أضف الأشخاص بكتابة اسم أو بريد أو رقم بدلًا من ذلك.',
    tryAgain: 'حاول مرة أخرى',
    searchContacts: 'ابحث في جهات الاتصال',
    contactCount: {
      zero: 'لا جهات اتصال',
      one: 'جهة اتصال واحدة',
      two: 'جهتا اتصال',
      few: '{n} جهات اتصال',
      many: '{n} جهة اتصال',
      other: '{n} جهة اتصال',
    },
    clearSearch: 'امسح البحث',
    nobodyHere: 'لا أحد هنا',
    noContactMatches: 'لا تطابق أي جهة اتصال ذلك.',
    noneHasEmailOrNumber: 'لا يملك أي من جهات اتصالك بريدًا أو رقمًا.',
    onlyPickedAreSent: 'لا يُرسل إلى باقي إلا من تختارهم. تبقى جهات اتصالك على هذا الهاتف.',
    jumpToLetter: 'انتقل إلى حرف',
    country: 'البلد',
    dialCodeTitle: 'رمز الدولة',
    searchCountry: 'ابحث عن دولة',
    settlesWith: '{country} · التسوية عبر {rails}',
    notSet: 'غير محدد',
    notSetRails: 'تحويل بنكي ونقد وWise وRevolut',
    countryNote:
      'يحدّد هذا كيف يمكنكم الدفع لبعضكم، وبأي عملة يبدأ المصروف الجديد. ولا يتغيّر شيء مما سُجّل من قبل.',
    starts: 'يبدأ',
    ends: 'ينتهي',
    dailyReminders: 'تذكيرات يومية',
    breakfast: 'الإفطار',
    endOfDay: 'نهاية اليوم',
    clearDates: 'امسح التواريخ',
    nobodyPickedYet: 'لم تختر أحدًا بعد',
    personCount: {
      zero: '{n} شخص',
      one: 'شخص واحد',
      two: 'شخصان',
      few: '{n} أشخاص',
      many: '{n} شخصًا',
      other: '{n} شخص',
    },
    alreadyAddedName: '{name}، مضاف بالفعل',
    alreadyInGroup: 'موجود بالفعل في هذه المجموعة',
    removeName: 'إزالة {name}',
    remindZoneNote: 'يُسأل بتوقيت {zone} — حيث الرحلة، لا حيث كل شخص.',
    useMyTimezone: 'استخدم منطقتي الزمنية ({zone})',
  },
  dispute: {
    yourReply: 'ردّك',
    replyPlaceholder: 'اختياري — ما الذي حدث فعلًا',
    saving: 'جارٍ الحفظ…',
    theyAreRight: 'معهم حق — سأصحّحه',
    itIsCorrect: 'إنه صحيح',
    answerThis: 'ردّ على هذا',
    youSaidWrong: 'قلت إن هذا خطأ',
    whatIsWrong: 'ما الخطأ في هذا المصروف',
    reasonPlaceholder: 'غادرت قبل الحلوى · كان المجموع ١٨٠٠',
    reasonOptional: 'السبب اختياري، لكنه الفرق بين تصحيحٍ ونقاش.',
    fixItMyself: 'سأصحّحه بنفسي',
  },
  upgradeScreen: {
    moreScans: 'مسح فواتير أكثر',
    moreScansBody:
      'صوّر إيصالًا لتُقرأ أصنافه. كل عملية مسح تكلّف مالًا حقيقيًا، وهذا هو السبب الصريح لكونها الشيء الوحيد المحدود.',
    biggerTransfers: 'تصدير واستيراد أكبر',
    biggerTransfersBody:
      'بياناتك لك وتخرج كاملة مجانًا. الأعمال الأكبر والنسخ الاحتياطي المجدول هي الراحة التي تُدفع.',
    nothingToBuy: 'لا شيء للشراء بعد',
    nothingToBuyBody:
      'هذا هو الباب، لا المتجر. حين يوجد ما يستحق الدفع سيكون هنا، بسعره ودون مفاجآت.',
    whatWouldCost: 'ما الذي قد يكلّف مالًا يومًا',
    whatNeverWill: 'وما لن يكلّف أبدًا',
    whatNeverWillBody:
      'الدفتر. المجموعات والمصاريف والتقسيمات والأرصدة والتسوية، وإخراج كل ذلك مرة أخرى — {free}. الدفتر الذي لا تقرأ منه إلا نصفه ليس دفترًا.',
  },
  promo: {
    row: 'استخدام رمز',
    rowHint: 'إن أعطاك أحدهم واحدًا',
    title: 'استخدام رمز',
    intro: 'تُمنح الرموز يدويًا — لحالة دعم، أو شكرًا، أو للتجربة.',
    placeholder: 'BAAKI2026',
    redeem: 'استخدام',
    granted: 'تم',
    grantedBody: 'Plus مفعّل حتى {until}. لم يُخصم شيء، ولا شيء يتجدد تلقائيًا.',
    unknownCode: 'لا يوجد رمز كهذا. راجع الحروف والأرقام.',
    expired: 'انتهى تاريخ هذا الرمز.',
    exhausted: 'استُخدم هذا الرمز بالعدد المسموح به.',
    alreadyRedeemed: 'لقد استخدمته من قبل.',
    couldNotRedeem: 'تعذّر التحقق من الرمز الآن. حاول بعد قليل.',
  },
  claims: {
    askToJoinAs: 'اطلب الانضمام بصفتك {name}',
    needsConfirming: 'يؤكّد ذلك أحد مشرفي المجموعة قبل أن يتغيّر أي شيء.',
    waitingTitle: 'تم الطلب',
    waitingBody:
      'على أحد القائمين على {group} أن يؤكّد أنك {name}. ستُخبَر بالنتيجة في الحالتين — ولم يتغيّر شيء في المجموعة بعد.',
    joinAsNewInstead: 'انضم بصفتك شخصًا جديدًا',
    requestsTitle: 'في انتظار الانضمام',
    saysTheyAre: 'يقول {who} إنه {name}',
    approve: 'تأكيد',
    decline: 'ليس هو',
    decideFailed: 'تعذّر الرد الآن. حاول بعد قليل.',
    alreadyDecided: 'ردّ أحدهم على هذا من قبل.',
    placeTaken: 'صار ذلك المكان لشخص آخر.',
    theyAreAlreadyIn: 'هو بالفعل في هذه المجموعة.',
  },
  privacy: {
    row: 'الخصوصية والأمان',
    rowHint: 'ما الذي يُحفظ، وكيف يُحمى',
    title: 'الخصوصية والأمان',
    intro: 'يحتفظ باقي بأقل قدر ممكن عنك مع بقائه صالحًا للعمل. وهذا بيان بما يحتفظ به.',
    storeTitle: 'ما الذي يُحفظ',
    storeBody:
      'اسمك، وما استخدمته من رقم هاتف أو بريد أو هوية دخول. واختياريًا عنوان دفع كي يتمكن أحدهم من ردّ المال إليك، وبلد. المجموعات التي تشارك فيها ومصروفاتها ومن يدين لمن. لا شيء غير ذلك: لا تُرفع جهات الاتصال، ولا يوجد معرّف إعلاني.',
    protectTitle: 'كيف يُحمى',
    protectBody:
      'كل جدول محميّ بأمان على مستوى الصف داخل قاعدة البيانات — ليس ترشيحًا يجريه التطبيق، بل قاعدة تفرضها قاعدة البيانات نفسها. صور الإيصالات في مكان خاص لا يُوصل إليه إلا بروابط قصيرة الأجل. وتُنقّى تقارير الأعطال من العناوين والأرقام وعناوين الدفع قبل مغادرتها الهاتف.',
    choicesTitle: 'ما الذي يمكنك فعله',
    choicesBody:
      'تصدير كل ما أدخلته، في أي وقت، كاملًا ومجانًا. إيقاف أي إشعار. حذف حسابك والبيانات الشخصية التي فيه.',
    englishGoverns:
      'هذا النص مترجم للتيسير. وعند الاختلاف بين الترجمة والإنجليزية، تكون الإنجليزية هي المعتمدة.',
    couldNotSave: 'لم يُحفظ هذا. أعد المحاولة بعد قليل.',
    analyticsTitle: 'كيف يُستخدم التطبيق',
    analyticsBody:
      'يمكن لـ Microsoft Clarity تسجيل كيفية استخدام الشاشات لمعرفة أين يتعثر الناس. يأتي مُعطّلًا ولا يسجّل شيئًا ما لم يُفعّل. ولا يُستخدم للإعلانات أبدًا، ولا يوجد معرّف إعلاني، ولا يُباع شيء أو يُشارَك.',
    sessionReplayRow: 'سجّل كيف أستخدم التطبيق',
    previewGroups: {
      zero: 'أنت في {n} مجموعة.',
      one: 'أنت في مجموعة واحدة.',
      two: 'أنت في مجموعتين.',
      few: 'أنت في {n} مجموعات.',
      many: 'أنت في {n} مجموعة.',
      other: 'أنت في {n} مجموعة.',
    },
    previewExpenses: {
      zero: 'ستبقى {n} من المصروفات التي أدخلتها.',
      one: 'سيبقى مصروف واحد أدخلته.',
      two: 'سيبقى مصروفان أدخلتهما.',
      few: 'ستبقى {n} مصروفات أدخلتها.',
      many: 'ستبقى {n} مصروفًا أدخلته.',
      other: 'ستبقى {n} من المصروفات التي أدخلتها.',
    },
    previewSettlements: {
      zero: 'اسمك مذكور في {n} تسوية.',
      one: 'اسمك مذكور في تسوية واحدة.',
      two: 'اسمك مذكور في تسويتين.',
      few: 'اسمك مذكور في {n} تسويات.',
      many: 'اسمك مذكور في {n} تسوية.',
      other: 'اسمك مذكور في {n} تسوية.',
    },
    previewOutstanding: 'لا يزال لديك رصيد غير مسوّى بـ {list}.',
    feedbackRow: 'أرسل ملاحظاتك',
    feedbackRowHint: 'أخبرنا بما لا يعمل أو بما ينقص',
    feedbackTitle: 'أرسل ملاحظاتك',
    feedbackHint: 'يقرأها إنسان. اكتب ما تشاء — وكلما كان محددًا كان أنفع.',
    feedbackPlaceholder: 'ماذا حدث، أو ما الذي كنت تتمناه',
    feedbackSend: 'إرسال',
    feedbackThanks: 'شكرًا — وصلتنا.',
    kindGeneral: 'عام',
    kindBug: 'شيء لا يعمل',
    kindIdea: 'فكرة',
    deleteRow: 'احذف بياناتي',
    deleteRowHint: 'إزالة حسابك وتفاصيلك الشخصية',
    deleteTitle: 'احذف بياناتي',
    deleteIntro:
      'لا يمكن التراجع عن هذا. اقرأ ما يُحذف وما لا يُحذف — والجزء الثاني هو ما يفاجئ الناس.',
    deleteGoesTitle: 'ما الذي يُحذف',
    deleteGoesBody:
      'اسمك وصورتك وعنوان الدفع والبلد واللغة وإعدادات الإشعارات. وتسجيل دخولك، فلا يُفتح هذا الحساب بعدها. وأجهزتك وسجل إشعاراتك ومشترياتك.',
    deleteStaysTitle: 'ما الذي يبقى، ولماذا',
    deleteStaysBody:
      'تبقى المصروفات والتسويات في مجموعاتك المشتركة، لأنها سجلات الآخرين أيضًا — وهي ما يحدد من يدين لمن. وحذفها يغيّر حساب شخص آخر بصمت ويُسقط دَينًا لم يسدده أحد. تصبح عضوًا سابقًا بلا اسم في تلك المجموعات.',
    deleteExportFirst: 'صدّر بياناتك أولًا',
    deleteWhyLabel: 'لماذا تغادر؟ (اختياري)',
    deleteWhyPlaceholder: 'معرفة السبب تفيدنا، ويُحتفظ بها بعد زوال الحساب',
    deleteConfirmLabel: 'اكتب DELETE للتأكيد',
    deleteConfirmWord: 'DELETE',
    deleteButton: 'احذف بياناتي',
    deleteWorking: 'جارٍ الحذف…',
    deleteDone: 'تم حذف بياناتك.',
    deleteSummary: {
      zero: 'أنت الآن عضو سابق في {n} مجموعة.',
      one: 'أنت الآن عضو سابق في مجموعة واحدة.',
      two: 'أنت الآن عضو سابق في مجموعتين.',
      few: 'أنت الآن عضو سابق في {n} مجموعات.',
      many: 'أنت الآن عضو سابق في {n} مجموعة.',
      other: 'أنت الآن عضو سابق في {n} مجموعة.',
    },
  },
  extras: {
    blankNameHint: 'اتركه فارغًا فتُسمّى المجموعة بأسماء من فيها.',
    whatKindOfGroup: 'أي نوع من المجموعات؟',
    typeTrip: 'رحلة',
    typeHome: 'المنزل',
    typeCouple: 'ثنائي',
    typeEvent: 'مناسبة',
    typeOther: 'أخرى',
    addPeopleByName: 'أضف أصدقاء',
    ghostNote: 'لا يحتاجون التطبيق. أضفهم الآن ويمكنهم المطالبة بسجلّهم لاحقًا.',
    claimHistoryNote: 'اختر اسمك فيأتي معك كل ما سُجّل لك من قبل.',
    theirPastBecomesYours: 'تصبح مصاريفهم وأرصدتهم السابقة لك.',
    guestKeepsItHere:
      'الانضمام كضيف يُبقي كل شيء على هذا الجهاز. أضف رقم هاتف لاحقًا فيتبعك كل شيء إلى هاتف آخر.',
    lockedTitle: 'باقي مقفل',
    lockedBody: 'افتحه بالوجه أو البصمة نفسها التي تفتح هذا الهاتف.',
    unlock: 'فتح',
    paidIn: 'دُفع بـ',
    iKnowTheRate: 'أعرف السعر',
    notAnAmountShort: 'ليس مبلغًا',
    oneChangeFailed: 'تعذّر حفظ تغيير واحد',
    tryAgain: 'حاول مرة أخرى',
    discardIt: 'تجاهله',
    needsUpdating: 'يحتاج باقي إلى تحديث',
    nothingIsLost:
      'لم يضع شيء. كل مجموعة ومصروف وتسوية موجودة على الخادم وستجدها تمامًا حيث تركتها.',
    worthAMinute: 'يستحق دقيقة حين تتوفر لديك.',
    theGroup: 'المجموعة',
    noGroupsYet:
      'ليست لديك مجموعات بعد. في باقي ينتمي الشخص إلى مجموعة، لأن الدَّين يكون دائمًا عن شيء ما — رحلة أو سكن أو عشاء.',
    ghostShareNote:
      'لا يحتاجون التطبيق. تُسجَّل حصتهم باسمهم، وإن انضمّوا لاحقًا بهذا البريد أو الرقم طالبوا بكل ما ينتظرهم هناك.',
    justMe: 'أنا فقط',
    yourShareNote: 'أنا فقط — كل مبلغ هو حصتك، وليس المصروف كاملاً.',
    sms: 'رسالة نصية',
    email: 'البريد',
    paymentWentThrough: 'هل تمّت الدفعة؟',
    onlyIfCompleted: 'لا تسجّلها إلا إذا تمّت فعلًا.',
    restAppliesOverall: 'يُطبَّق الباقي على الرصيد الإجمالي، بدءًا بأقدم مصروف.',
    couldNotReadImage: 'تعذّرت قراءة تلك الصورة.',
    deliveryComesLater:
      'يأتي الإرسال عبر الإشعارات والبريد مع M4. وحتى ذلك الحين يصل كل شيء إلى هنا.',
    perCurrencyNote:
      'تُحفظ المبالغ لكل عملة على حدة، ولا تُحوَّل أبدًا إلى مجموع واحد. ومن ليس لهم حساب يُحصَون في كل مجموعة على حدة، لأن شخصين قد يحملان الاسم نفسه.',
    savedStraightAway:
      'يُحفظ على هذا الهاتف فورًا، بإشارة أو بدونها. يعيد الخادم حساب كل حصة قبل تخزينها، فلا يستطيع أي جهاز دفع رقم خاطئ إلى الدفتر.',
    nothingOverwritten:
      'لا يُستبدل هنا شيء أبدًا. تُحفظ كل نسخة أعلاه، ويمكن استرجاع مصروف محذوف خلال 30 يومًا.',
  },
  errorBoundary: {
    title: 'حدث خطأ ما',
    body: 'واجهت تلك الشاشة خطأ. لم يُفقد أي شيء حفظته — ارجع وحاول مرة أخرى.',
    action: 'العودة إلى الرئيسية',
  },
};

const STRINGS: Record<Language, UiStrings> = {
  [Language.En]: en,
  [Language.Ta]: ta,
  [Language.Hi]: hi,
  [Language.Ar]: ar,
};

/**
 * The tables themselves, so a test can check that every language says
 * everything. A missing key is not a crash — it is `undefined` rendered as a
 * blank on one screen in one language, which is exactly the kind of thing that
 * ships.
 */
export const STRINGS_BY_LANGUAGE = STRINGS;

export function deviceLanguage(): Language {
  const tag = getLocales()[0]?.languageCode ?? 'en';
  return tag === 'ta'
    ? Language.Ta
    : tag === 'hi'
      ? Language.Hi
      : tag === 'ar'
        ? Language.Ar
        : Language.En;
}

/**
 * The chosen language, readable from outside React.
 *
 * `useStrings` is the way to read strings and stays the way — every screen goes
 * through it. This exists for the handful of places that have to say something
 * to a person from outside the tree: `readFunctionError` in `data/api` turns an
 * edge function's English refusal into a sentence, and it is a plain async
 * function called from a mutation, not a component.
 *
 * Written by `LanguageProvider` and by nobody else, so it cannot drift from
 * what is on screen. Before the provider mounts it is null and the phone's own
 * language answers — the same default the provider itself starts from.
 */
let chosenLanguage: Language | null = null;

export function setActiveLanguage(language: Language): void {
  chosenLanguage = language;
}

export function activeStrings(): UiStrings {
  return STRINGS[chosenLanguage ?? deviceLanguage()];
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
  const alpha2 = (value: string | null | undefined): string | null =>
    value && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;

  // Walk the phone's locale list, not just the first entry. `regionCode` is the
  // device Region setting (Language & Region), so a phone whose Region is India
  // reads IN even with an English (US) display language — but on a device where
  // the top locale carries no region, a later one or the tag itself still can.
  for (const locale of getLocales()) {
    const fromRegion = alpha2(locale.regionCode) ?? alpha2(locale.languageRegionCode);
    if (fromRegion) return fromRegion;
    // `en-IN` with a null regionCode still names the region in its tag. Only a
    // tag that actually carries a region subtag counts — a bare `en` has no
    // country in it and must not be read as the country "EN".
    const tag = locale.languageTag ?? '';
    const fromTag = tag.includes('-') ? alpha2(tag.split('-').pop()) : null;
    if (fromTag) return fromTag;
  }
  return null;
}

/**
 * The currency a brand-new group starts in on this phone — and therefore the
 * one to show a zero in before any group exists.
 *
 * The new-group form derives its currency the same way (`currencyForCountry`
 * of the device country, INR when the country is unknown), so the home
 * screen's empty state and a group made a moment later agree instead of the
 * home showing ₹0 and the group then counting in dollars. India is the last
 * resort, not an American fallback: an unrecognised country is not the US.
 */
export function deviceDefaultCurrency(): CurrencyCode {
  return currencyForCountry(deviceCountry()) ?? 'INR';
}

/**
 * The dialing prefix to start a phone field with on this phone, as `+<digits>`,
 * or a bare `+` when the region is unknown or unlisted.
 *
 * Follows the phone rather than assuming +91: a handset set to the UAE opens on
 * +971, one set to the UK on +44, and one whose region Baaki does not stock
 * gets a lone `+` to type over — never a confident wrong country code.
 */
export function deviceDialingCode(): string {
  return dialingCodeForCountry(deviceCountry()) ?? '+';
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
