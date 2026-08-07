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
  skip: 'தவிர்',
  next: 'அடுத்து',
  getStarted: 'தொடங்கலாம்',
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
  skip: 'छोड़ें',
  next: 'आगे',
  getStarted: 'शुरू करें',
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
