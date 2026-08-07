/**
 * i18n from day one (TDR §11): en, ta, hi and now ar, with locale-aware money
 * and date formatting everywhere. Notification copy lives in
 * @baaki/core/notifications so the server sends the same words.
 *
 * Arabic is the first right-to-left language here, and it is more than a fourth
 * column of strings — the whole layout mirrors. React Native does that itself
 * when `I18nManager.isRTL` is true, which the OS sets from the phone's own
 * language, so there is no switch in this app to flip: somebody whose phone is
 * in Arabic gets Arabic and a mirrored layout, and everybody else does not.
 * `extra.supportsRTL` in app.json is what lets the native side honour it.
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

import { getLocales } from 'expo-localization';

import type { CategoryId } from '@baaki/core';

export type Language = 'en' | 'ta' | 'hi' | 'ar';

/** The languages that read right to left. */
export const RTL_LANGUAGES: readonly Language[] = ['ar'];

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
  skip: string;
  next: string;
  getStarted: string;
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
  skip: 'Skip',
  next: 'Next',
  getStarted: 'Get started',
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
};

const ta: UiStrings = {
  ...en,
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
  freeForever: 'எப்போதும் இலவசம்',
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
};

const hi: UiStrings = {
  ...en,
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
  freeForever: 'हमेशा मुफ़्त',
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
  skip: 'تخطٍ',
  next: 'التالي',
  getStarted: 'لنبدأ',
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

export function useStrings(): { t: UiStrings; locale: string; language: Language } {
  const language = deviceLanguage();
  return { t: STRINGS[language], locale: deviceLocale(), language };
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
}
