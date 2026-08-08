/**
 * The words on the four pages a guest sees, in the four languages the app
 * speaks.
 *
 * Separate from `apps/mobile/src/i18n` on purpose and not shared through a
 * package: that module imports `react-native` and `expo-localization` at the
 * top, and this is a Next app. What is shared is the *shape* — a closed
 * `WebStrings` interface with no spread of English underneath it, so adding a
 * key is a compile error in all four languages until somebody writes the words.
 *
 * The language is decided on the server from `Accept-Language`, which is what
 * lets `<html lang>` and `dir` be right in the first paint rather than
 * corrected a frame later. A guest arriving on an Arabic phone should not watch
 * the page turn around.
 */

export type Language = 'en' | 'ta' | 'hi' | 'ar';

export const LANGUAGES: readonly Language[] = ['en', 'ta', 'hi', 'ar'];

export function isRtlLanguage(language: Language): boolean {
  return language === 'ar';
}

/**
 * The best of the languages the browser asked for.
 *
 * `Accept-Language` is already in preference order and carries quality values
 * we do not need to weigh: the first tag whose language subtag is one of ours
 * is the answer, and English is the answer when none of them is.
 */
export function pickLanguage(acceptLanguage: string | null | undefined): Language {
  if (!acceptLanguage) return 'en';
  for (const part of acceptLanguage.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase();
    const subtag = tag?.split('-')[0];
    if (subtag && (LANGUAGES as readonly string[]).includes(subtag)) {
      return subtag as Language;
    }
  }
  return 'en';
}

/**
 * The locale money and dates are formatted in.
 *
 * The region is kept from whatever the browser asked for, so somebody reading
 * in Hindi from Dubai still sees `hi-AE` money. Choosing a language is not
 * choosing a country.
 */
export function localeFor(language: Language, acceptLanguage: string | null | undefined): string {
  if (!acceptLanguage) return language;
  for (const part of acceptLanguage.split(',')) {
    const tag = part.split(';')[0]?.trim();
    if (tag?.toLowerCase().startsWith(language + '-')) return tag;
  }
  return language;
}

export interface PluralForms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

/** The right form for `count`, with the number formatted for the locale. */
export function plural(locale: string, count: number, forms: PluralForms): string {
  let rule: Intl.LDMLPluralRule = 'other';
  let shown = String(count);
  try {
    rule = new Intl.PluralRules(locale).select(count);
    shown = new Intl.NumberFormat(locale).format(count);
  } catch {
    // A locale Intl will not take is not a reason to render nothing.
  }
  return (forms[rule] ?? forms.other).replaceAll('{n}', shown);
}

export interface WebStrings {
  /** The page somebody reaches by typing the domain in. */
  home: {
    title: string;
    description: string;
    elsewhere: string;
  };
  /** The invite link, which is the whole growth loop (ADR-006). */
  join: {
    linkBroken: string;
    linkBrokenBody: string;
    opening: string;
    aGroup: string;
    addedTo: string;
    splittingHere: PluralForms;
    whichOneAreYou: string;
    claimNote: string;
    someone: string;
    noneOfThese: string;
    yourName: string;
    namePlaceholder: string;
    onlyThingAsked: string;
    joining: string;
    joinGroup: string;
    askToJoinAs: string;
    waitingTitle: string;
    waitingBody: string;
    joinAsNewInstead: string;
  };
  /** The group, in a browser: less than the app, and enough for a trip. */
  group: {
    loading: string;
    notYours: string;
    notYoursBody: string;
    yourGroup: string;
    peopleCount: PluralForms;
    expenseCount: PluralForms;
    whereEveryoneStands: string;
    settledUp: string;
    isSettledUp: string;
    isOwed: string;
    owes: string;
    whoPaysWhom: string;
    whoPaysWhomNote: string;
    recent: string;
    addAnExpense: string;
    installNote: string;
  };
  /** Adding one expense, equally split, and nothing cleverer. */
  add: {
    title: string;
    defaultDescription: string;
    whatWasIt: string;
    howMuch: string;
    amountIn: string;
    notAnAmount: string;
    whoPaid: string;
    you: string;
    splitBetween: string;
    splitEquallyNote: string;
    saving: string;
    save: string;
    cancel: string;
  };
}

const en: WebStrings = {
  home: {
    title: 'Baaki',
    description:
      'Split expenses without the argument at the end. This page is only for opening an invite link — if somebody shared a group with you, open their link rather than this address.',
    elsewhere: 'Everything else lives in the app.',
  },
  join: {
    linkBroken: 'This link does not work',
    linkBrokenBody: 'Links expire, and whoever shared it can turn it off. Ask them for a new one.',
    opening: 'Opening the link…',
    aGroup: 'a group',
    addedTo: 'You have been added to {group}',
    splittingHere: {
      one: '{n} person is splitting costs here. You can join and add an expense right now — nothing to install.',
      other:
        '{n} people are splitting costs here. You can join and add an expense right now — nothing to install.',
    },
    whichOneAreYou: 'Which one are you?',
    claimNote:
      'Somebody already added these names. Picking yours keeps the expenses already filed against it.',
    someone: 'Someone',
    noneOfThese: 'None of these',
    yourName: 'Your name',
    namePlaceholder: 'What should they call you?',
    onlyThingAsked: 'This is the only thing asked of you. No email, no password, no app.',
    joining: 'Joining…',
    joinGroup: 'Join {group}',
    askToJoinAs: 'Ask to join as {name}',
    waitingTitle: 'Asked',
    waitingBody:
      'Somebody who runs {group} has to confirm you are {name}. Nothing has changed in the group yet.',
    joinAsNewInstead: 'Join as someone new instead',
  },
  group: {
    loading: 'Loading…',
    notYours: 'Not your group',
    notYoursBody:
      'This browser is not a member of this group. If somebody sent you a link, open that instead.',
    yourGroup: 'Your group',
    peopleCount: { one: '{n} person', other: '{n} people' },
    expenseCount: { one: '{n} expense', other: '{n} expenses' },
    whereEveryoneStands: 'Where everyone stands',
    settledUp: 'settled up',
    isSettledUp: 'is settled up',
    isOwed: 'is owed',
    owes: 'owes',
    whoPaysWhom: 'Who pays whom',
    whoPaysWhomNote:
      'The fewest payments that settle everybody. Nobody is made to pay somebody they never split anything with.',
    recent: 'Recent',
    addAnExpense: 'Add an expense',
    installNote:
      'Install Baaki to scan receipts, settle over UPI and keep this working without a signal.',
  },
  add: {
    title: 'Add an expense',
    defaultDescription: 'Expense',
    whatWasIt: 'What was it?',
    howMuch: 'How much? ({currency})',
    amountIn: 'Amount in {currency}',
    notAnAmount: 'That is not an amount.',
    whoPaid: 'Who paid',
    you: 'You',
    splitBetween: 'Split between',
    splitEquallyNote: 'Split equally. For exact shares or an itemised bill, use the app.',
    saving: 'Saving…',
    save: 'Save',
    cancel: 'Cancel',
  },
};

const ta: WebStrings = {
  home: {
    title: 'பாக்கி',
    description:
      'கடைசியில் வாக்குவாதம் இல்லாமல் செலவுகளைப் பிரியுங்கள். இந்தப் பக்கம் அழைப்புச் சுட்டியைத் திறக்க மட்டுமே — யாராவது ஒரு குழுவை உங்களுடன் பகிர்ந்திருந்தால், இந்த முகவரிக்குப் பதிலாக அவர்களின் சுட்டியைத் திறக்கவும்.',
    elsewhere: 'மற்ற அனைத்தும் செயலியில் உள்ளது.',
  },
  join: {
    linkBroken: 'இந்தச் சுட்டி வேலை செய்யவில்லை',
    linkBrokenBody:
      'சுட்டிகள் காலாவதியாகும், பகிர்ந்தவர் அதை நிறுத்தவும் முடியும். புதிய ஒன்றைக் கேளுங்கள்.',
    opening: 'சுட்டியைத் திறக்கிறது…',
    aGroup: 'ஒரு குழு',
    addedTo: '{group} இல் நீங்கள் சேர்க்கப்பட்டுள்ளீர்கள்',
    splittingHere: {
      one: '{n} நபர் இங்கே செலவுகளைப் பிரிக்கிறார். இப்போதே சேர்ந்து ஒரு செலவைச் சேர்க்கலாம் — எதுவும் நிறுவ வேண்டாம்.',
      other:
        '{n} பேர் இங்கே செலவுகளைப் பிரிக்கிறார்கள். இப்போதே சேர்ந்து ஒரு செலவைச் சேர்க்கலாம் — எதுவும் நிறுவ வேண்டாம்.',
    },
    whichOneAreYou: 'நீங்கள் யார்?',
    claimNote:
      'இந்தப் பெயர்களை ஏற்கெனவே யாரோ சேர்த்துவிட்டார்கள். உங்களுடையதைத் தேர்ந்தெடுத்தால், அதற்கு எதிராக ஏற்கெனவே பதிவான செலவுகள் உங்களுடன் இருக்கும்.',
    someone: 'யாரோ',
    noneOfThese: 'இவை எதுவும் இல்லை',
    yourName: 'உங்கள் பெயர்',
    namePlaceholder: 'உங்களை என்ன அழைக்க வேண்டும்?',
    onlyThingAsked:
      'உங்களிடம் கேட்கப்படுவது இது ஒன்றுதான். மின்னஞ்சல் இல்லை, கடவுச்சொல் இல்லை, செயலி இல்லை.',
    joining: 'சேர்கிறது…',
    joinGroup: '{group} இல் சேர்',
    askToJoinAs: '{name} ஆக சேர அனுமதி கேளுங்கள்',
    waitingTitle: 'கேட்கப்பட்டது',
    waitingBody:
      'நீங்கள் {name} தானா என்பதை {group} நடத்துபவர் உறுதி செய்ய வேண்டும். குழுவில் இன்னும் எதுவும் மாறவில்லை.',
    joinAsNewInstead: 'புதிய நபராகச் சேருங்கள்',
  },
  group: {
    loading: 'ஏற்றுகிறது…',
    notYours: 'உங்கள் குழு அல்ல',
    notYoursBody:
      'இந்த உலாவி இந்தக் குழுவின் உறுப்பினர் அல்ல. யாராவது உங்களுக்கு ஒரு சுட்டி அனுப்பியிருந்தால், அதைத் திறக்கவும்.',
    yourGroup: 'உங்கள் குழு',
    peopleCount: { one: '{n} நபர்', other: '{n} நபர்கள்' },
    expenseCount: { one: '{n} செலவு', other: '{n} செலவுகள்' },
    whereEveryoneStands: 'யார் எங்கே நிற்கிறார்கள்',
    settledUp: 'தீர்ந்தது',
    isSettledUp: 'கணக்கு தீர்ந்தது',
    isOwed: 'பெற வேண்டியது',
    owes: 'தர வேண்டியது',
    whoPaysWhom: 'யார் யாருக்குத் தருவது',
    whoPaysWhomNote:
      'அனைவரையும் தீர்க்கும் மிகக் குறைந்த கொடுப்பனவுகள். எதையும் சேர்ந்து பிரிக்காத ஒருவருக்கு யாரும் பணம் தர வேண்டியதில்லை.',
    recent: 'சமீபத்தியவை',
    addAnExpense: 'ஒரு செலவைச் சேர்',
    installNote:
      'ரசீதுகளை ஸ்கேன் செய்ய, UPI மூலம் தீர்க்க, சிக்னல் இல்லாமலும் இது வேலை செய்ய — பாக்கியை நிறுவுங்கள்.',
  },
  add: {
    title: 'ஒரு செலவைச் சேர்',
    defaultDescription: 'செலவு',
    whatWasIt: 'எதற்காக?',
    howMuch: 'எவ்வளவு? ({currency})',
    amountIn: '{currency} இல் தொகை',
    notAnAmount: 'அது ஒரு தொகை அல்ல.',
    whoPaid: 'யார் கொடுத்தார்கள்',
    you: 'நீங்கள்',
    splitBetween: 'யாருக்கிடையே',
    splitEquallyNote:
      'சமமாகப் பிரிக்கப்பட்டது. சரியான பங்குகளுக்கோ பொருள் வாரியான ரசீதுக்கோ செயலியைப் பயன்படுத்துங்கள்.',
    saving: 'சேமிக்கிறது…',
    save: 'சேமி',
    cancel: 'ரத்து',
  },
};

const hi: WebStrings = {
  home: {
    title: 'बाकी',
    description:
      'आख़िर में बहस किए बिना खर्च बाँटें। यह पेज सिर्फ़ न्योते का लिंक खोलने के लिए है — अगर किसी ने आपके साथ कोई समूह साझा किया है, तो इस पते के बजाय उनका लिंक खोलें।',
    elsewhere: 'बाकी सब कुछ ऐप में है।',
  },
  join: {
    linkBroken: 'यह लिंक काम नहीं करता',
    linkBrokenBody:
      'लिंक की मियाद ख़त्म हो जाती है, और जिसने साझा किया वह उसे बंद भी कर सकता है। उनसे नया माँगें।',
    opening: 'लिंक खुल रहा है…',
    aGroup: 'एक समूह',
    addedTo: 'आपको {group} में जोड़ा गया है',
    splittingHere: {
      one: '{n} व्यक्ति यहाँ खर्च बाँट रहा है। आप अभी जुड़कर खर्च जोड़ सकते हैं — कुछ भी इंस्टॉल नहीं करना।',
      other:
        '{n} लोग यहाँ खर्च बाँट रहे हैं। आप अभी जुड़कर खर्च जोड़ सकते हैं — कुछ भी इंस्टॉल नहीं करना।',
    },
    whichOneAreYou: 'इनमें आप कौन हैं?',
    claimNote:
      'ये नाम पहले ही किसी ने जोड़ दिए हैं। अपना चुनने से उस नाम पर पहले से दर्ज खर्च आपके साथ रहते हैं।',
    someone: 'कोई',
    noneOfThese: 'इनमें से कोई नहीं',
    yourName: 'आपका नाम',
    namePlaceholder: 'वे आपको क्या कहकर बुलाएँ?',
    onlyThingAsked: 'आपसे बस यही पूछा जाता है। न ईमेल, न पासवर्ड, न ऐप।',
    joining: 'जुड़ रहे हैं…',
    joinGroup: '{group} में जुड़ें',
    askToJoinAs: '{name} के रूप में शामिल होने की पूछें',
    waitingTitle: 'पूछ लिया',
    waitingBody:
      '{group} चलाने वाले किसी को पुष्टि करनी है कि आप {name} हैं। समूह में अभी कुछ नहीं बदला।',
    joinAsNewInstead: 'नए व्यक्ति के रूप में शामिल हों',
  },
  group: {
    loading: 'लोड हो रहा है…',
    notYours: 'यह आपका समूह नहीं',
    notYoursBody:
      'यह ब्राउज़र इस समूह का सदस्य नहीं है। अगर किसी ने आपको लिंक भेजा है, तो उसे खोलें।',
    yourGroup: 'आपका समूह',
    peopleCount: { one: '{n} व्यक्ति', other: '{n} लोग' },
    expenseCount: { one: '{n} खर्च', other: '{n} खर्च' },
    whereEveryoneStands: 'किसका क्या हिसाब है',
    settledUp: 'हिसाब बराबर',
    isSettledUp: 'का हिसाब बराबर है',
    isOwed: 'को मिलने हैं',
    owes: 'को देने हैं',
    whoPaysWhom: 'कौन किसे देगा',
    whoPaysWhomNote:
      'सबका हिसाब बराबर करने वाले सबसे कम भुगतान। किसी को ऐसे व्यक्ति को पैसे देने के लिए नहीं कहा जाता जिसके साथ उसने कभी कुछ बाँटा ही नहीं।',
    recent: 'हाल के',
    addAnExpense: 'खर्च जोड़ें',
    installNote:
      'रसीदें स्कैन करने, UPI से निपटाने और बिना सिग्नल भी यह चलाने के लिए बाकी इंस्टॉल करें।',
  },
  add: {
    title: 'खर्च जोड़ें',
    defaultDescription: 'खर्च',
    whatWasIt: 'किस चीज़ का था?',
    howMuch: 'कितना? ({currency})',
    amountIn: '{currency} में रकम',
    notAnAmount: 'यह रकम नहीं है।',
    whoPaid: 'किसने दिया',
    you: 'आप',
    splitBetween: 'किनके बीच',
    splitEquallyNote: 'बराबर बाँटा गया। सटीक हिस्सों या चीज़-वार बिल के लिए ऐप इस्तेमाल करें।',
    saving: 'सेव हो रहा है…',
    save: 'सेव करें',
    cancel: 'रद्द करें',
  },
};

const ar: WebStrings = {
  home: {
    title: 'باقي',
    description:
      'قسّموا المصاريف دون خلاف في النهاية. هذه الصفحة لفتح رابط دعوة فقط — إن شاركك أحدهم مجموعة، فافتح رابطه بدل هذا العنوان.',
    elsewhere: 'كل ما عدا ذلك في التطبيق.',
  },
  join: {
    linkBroken: 'هذا الرابط لا يعمل',
    linkBrokenBody: 'تنتهي صلاحية الروابط، ويمكن لمن شاركها أن يوقفها. اطلب منه رابطًا جديدًا.',
    opening: 'جارٍ فتح الرابط…',
    aGroup: 'مجموعة',
    addedTo: 'تمت إضافتك إلى {group}',
    splittingHere: {
      zero: 'لا أحد يقسّم التكاليف هنا بعد. يمكنك الانضمام وإضافة مصروف الآن — دون تثبيت شيء.',
      one: 'شخص واحد يقسّم التكاليف هنا. يمكنك الانضمام وإضافة مصروف الآن — دون تثبيت شيء.',
      two: 'شخصان يقسّمان التكاليف هنا. يمكنك الانضمام وإضافة مصروف الآن — دون تثبيت شيء.',
      few: '{n} أشخاص يقسّمون التكاليف هنا. يمكنك الانضمام وإضافة مصروف الآن — دون تثبيت شيء.',
      many: '{n} شخصًا يقسّمون التكاليف هنا. يمكنك الانضمام وإضافة مصروف الآن — دون تثبيت شيء.',
      other: '{n} شخص يقسّمون التكاليف هنا. يمكنك الانضمام وإضافة مصروف الآن — دون تثبيت شيء.',
    },
    whichOneAreYou: 'أيّهم أنت؟',
    claimNote: 'أضاف أحدهم هذه الأسماء من قبل. اختيار اسمك يبقي المصاريف المسجّلة عليه معك.',
    someone: 'أحدهم',
    noneOfThese: 'لا أحد منهم',
    yourName: 'اسمك',
    namePlaceholder: 'بماذا ينادونك؟',
    onlyThingAsked: 'هذا كل ما يُطلب منك. لا بريد، ولا كلمة مرور، ولا تطبيق.',
    joining: 'جارٍ الانضمام…',
    joinGroup: 'انضم إلى {group}',
    askToJoinAs: 'اطلب الانضمام بصفتك {name}',
    waitingTitle: 'تم الطلب',
    waitingBody:
      'على أحد القائمين على {group} أن يؤكّد أنك {name}. ولم يتغيّر شيء في المجموعة بعد.',
    joinAsNewInstead: 'انضم بصفتك شخصًا جديدًا',
  },
  group: {
    loading: 'جارٍ التحميل…',
    notYours: 'ليست مجموعتك',
    notYoursBody:
      'هذا المتصفح ليس عضوًا في هذه المجموعة. إن أرسل إليك أحدهم رابطًا، فافتحه بدلًا من ذلك.',
    yourGroup: 'مجموعتك',
    peopleCount: {
      zero: 'لا أشخاص',
      one: 'شخص واحد',
      two: 'شخصان',
      few: '{n} أشخاص',
      many: '{n} شخصًا',
      other: '{n} شخص',
    },
    expenseCount: {
      zero: 'لا مصاريف',
      one: 'مصروف واحد',
      two: 'مصروفان',
      few: '{n} مصاريف',
      many: '{n} مصروفًا',
      other: '{n} مصروف',
    },
    whereEveryoneStands: 'أين يقف كل واحد',
    settledUp: 'مسوّى',
    isSettledUp: 'حسابه مسوّى',
    isOwed: 'له',
    owes: 'عليه',
    whoPaysWhom: 'من يدفع لمن',
    whoPaysWhomNote:
      'أقل عدد من الدفعات يسوّي حساب الجميع. ولا يُطلب من أحد أن يدفع لشخص لم يقسّم معه شيئًا قط.',
    recent: 'الأحدث',
    addAnExpense: 'أضف مصروفًا',
    installNote: 'ثبّت باقي لمسح الإيصالات والتسوية عبر UPI ولكي يعمل هذا دون اتصال.',
  },
  add: {
    title: 'أضف مصروفًا',
    defaultDescription: 'مصروف',
    whatWasIt: 'على ماذا؟',
    howMuch: 'كم؟ ({currency})',
    amountIn: 'المبلغ بـ {currency}',
    notAnAmount: 'هذا ليس مبلغًا.',
    whoPaid: 'من دفع',
    you: 'أنت',
    splitBetween: 'التقسيم بين',
    splitEquallyNote: 'قُسّم بالتساوي. للحصص المحددة أو فاتورة بالأصناف، استخدم التطبيق.',
    saving: 'جارٍ الحفظ…',
    save: 'حفظ',
    cancel: 'إلغاء',
  },
};

export const STRINGS_BY_LANGUAGE: Record<Language, WebStrings> = { en, ta, hi, ar };

export function stringsFor(language: Language): WebStrings {
  return STRINGS_BY_LANGUAGE[language];
}

/** Substitute `{name}` placeholders. */
export function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}
