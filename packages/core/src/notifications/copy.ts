/**
 * Centralised notification + money copy (TDR §7.1), en / ta / hi / ar.
 * Tone rule from ADR-010: friendly vasool, never collection-agency.
 * `{placeholders}` are substituted by the caller.
 *
 * Arabic arrived in the app four screens before it arrived here, and the gap
 * was silent: `copyFor('ar')` fell through `?? en` and sent English to somebody
 * whose whole app was in Arabic. A fallback that cannot be seen from the call
 * site is a fallback that ships. The four tables are now the same four the app
 * speaks, and `LanguageCode` is what makes adding a fifth a compile error here
 * rather than a surprise on somebody's lock screen.
 */

export type LanguageCode = 'en' | 'ta' | 'hi' | 'ar';

export type NotificationKind =
  | 'expense_added'
  | 'expense_edited'
  | 'expense_deleted'
  | 'you_owe'
  | 'settlement_initiated'
  | 'settlement_confirm_request'
  | 'settlement_confirmed'
  | 'nudge'
  | 'ghost_claimed'
  | 'group_invite_accepted'
  | 'digest_daily'
  /**
   * The two reminders that run for the length of a trip. Asked at breakfast
   * about yesterday and at the end of the day about today, because a ledger is
   * only as good as the habit of adding to it, and the habit needs prompting
   * while the receipts still exist.
   */
  | 'trip_nudge_morning'
  | 'trip_nudge_evening'
  /**
   * Somebody saying an expense is wrong. Worded as a correction rather than an
   * accusation on purpose (ADR-010): the common case is a genuine mistake, and
   * copy that treats it as a dispute makes a fight out of a typo.
   */
  | 'expense_disputed'
  | 'expense_dispute_resolved'
  /**
   * Somebody saying they are the "Ravi" already listed in a group, and an
   * admin answering (ADR-006). Approving hands over every share and settlement
   * already filed under that name, which is why it is asked rather than taken.
   */
  | 'ghost_claim_requested'
  | 'ghost_claim_approved'
  | 'ghost_claim_declined';

/**
 * The wrapping around a notification when it goes out as mail (TDR §7.3).
 *
 * The sentence itself is not here — an email says exactly what the inbox and
 * the push say, from `notifications` above, because they are the same
 * notification arriving by a different door. What an email needs on top is a
 * button, and the two lines at the bottom that a push has no room for and no
 * need of: why this arrived, and how to stop it.
 */
export interface EmailChrome {
  /** Button on a settlement mail — the one thing the recipient can act on. */
  readonly confirmAction: string;
  /** Button on everything else. */
  readonly openAction: string;
  readonly why: string;
  readonly unsubscribe: string;
  readonly signature: string;
}

export interface CopyStrings {
  readonly money: {
    readonly owedToYou: string;
    readonly youOwe: string;
    readonly settled: string;
    readonly netPositive: string;
    readonly netNegative: string;
  };
  readonly notifications: Readonly<Record<NotificationKind, { title: string; body: string }>>;
  readonly email: EmailChrome;
}

const en: CopyStrings = {
  money: {
    owedToYou: 'You are owed {amount}',
    youOwe: 'You owe {amount}',
    settled: 'All settled',
    netPositive: 'You are owed {amount} overall',
    netNegative: 'Your baaki is {amount}',
  },
  notifications: {
    expense_added: {
      title: '{actor} added an expense',
      body: '{description} · {amount} in {group}',
    },
    expense_edited: { title: '{actor} edited an expense', body: '{description} in {group}' },
    expense_deleted: { title: '{actor} removed an expense', body: '{description} in {group}' },
    you_owe: { title: 'You owe {amount}', body: '{description} in {group}' },
    settlement_initiated: {
      title: '{actor} paid you {amount}',
      body: 'Tap to confirm you received it',
    },
    settlement_confirm_request: {
      title: '{actor} says they paid you {amount}',
      body: 'Confirm so your baaki stays right',
    },
    settlement_confirmed: { title: 'Settled with {actor}', body: '{amount} in {group}' },
    nudge: { title: 'A gentle nudge from {actor}', body: '{amount} pending in {group}' },
    ghost_claimed: { title: '{actor} joined {group}', body: 'Their past expenses are now linked' },
    group_invite_accepted: { title: '{actor} joined {group}', body: 'Say hello' },
    digest_daily: { title: 'Today in {group}', body: '{count} updates · your baaki is {amount}' },
    trip_nudge_morning: {
      title: 'Anything from yesterday?',
      body: 'Add what you spent on {group} while you still remember it',
    },
    trip_nudge_evening: {
      title: 'Before you forget',
      body: 'What did you pay for today on {group}?',
    },
    expense_disputed: {
      title: '{actor} thinks something is off',
      body: '{description} in {group} — take a look',
    },
    expense_dispute_resolved: {
      title: 'Your correction was answered',
      body: '{description} in {group}',
    },
    ghost_claim_requested: {
      title: 'Someone wants to join {group}',
      body: 'They say they are {name}. Nothing changes until you confirm.',
    },
    ghost_claim_approved: {
      title: 'You are in {group}',
      body: 'Everything already filed under {name} is yours',
    },
    ghost_claim_declined: {
      title: 'Not confirmed',
      body: '{group} did not confirm that place. You can still join as yourself.',
    },
  },
  email: {
    confirmAction: 'Confirm you received it',
    openAction: 'Open Baaki',
    why: 'You are getting this because of {group} on Baaki.',
    unsubscribe: 'Stop emails like this',
    signature: 'Baaki',
  },
};

const ta: CopyStrings = {
  money: {
    owedToYou: 'உங்களுக்கு {amount} வர வேண்டும்',
    youOwe: 'நீங்கள் {amount} தர வேண்டும்',
    settled: 'எல்லாம் சரி',
    netPositive: 'மொத்தம் உங்களுக்கு {amount} வர வேண்டும்',
    netNegative: 'உங்கள் பாக்கி {amount}',
  },
  notifications: {
    expense_added: {
      title: '{actor} ஒரு செலவைச் சேர்த்தார்',
      body: '{description} · {amount} ({group})',
    },
    expense_edited: { title: '{actor} செலவைத் திருத்தினார்', body: '{description} ({group})' },
    expense_deleted: { title: '{actor} செலவை நீக்கினார்', body: '{description} ({group})' },
    you_owe: { title: 'நீங்கள் {amount} தர வேண்டும்', body: '{description} ({group})' },
    settlement_initiated: {
      title: '{actor} உங்களுக்கு {amount} அனுப்பியுள்ளார்',
      body: 'கிடைத்ததா என உறுதிப்படுத்தவும்',
    },
    settlement_confirm_request: {
      title: '{actor} {amount} கொடுத்ததாகச் சொல்கிறார்',
      body: 'உறுதிப்படுத்தினால் பாக்கி சரியாக இருக்கும்',
    },
    settlement_confirmed: { title: '{actor} உடன் தீர்ந்தது', body: '{amount} ({group})' },
    nudge: { title: '{actor} இடமிருந்து ஒரு நினைவூட்டல்', body: '{group} இல் {amount} பாக்கி' },
    ghost_claimed: { title: '{actor} {group} இல் இணைந்தார்', body: 'பழைய செலவுகள் இணைக்கப்பட்டன' },
    group_invite_accepted: { title: '{actor} {group} இல் இணைந்தார்', body: 'வரவேற்கலாம்' },
    digest_daily: { title: 'இன்று {group} இல்', body: '{count} புதுப்பிப்புகள் · பாக்கி {amount}' },
    trip_nudge_morning: {
      title: 'நேற்று ஏதாவது இருக்கா?',
      body: 'நினைவிருக்கும் போதே {group} செலவுகளைச் சேர்க்கவும்',
    },
    trip_nudge_evening: {
      title: 'மறப்பதற்கு முன்',
      body: 'இன்று {group} இல் என்ன செலவு செய்தீர்கள்?',
    },
    expense_disputed: {
      title: '{actor} ஏதோ தவறு என்கிறார்',
      body: '{description} ({group}) — பார்க்கவும்',
    },
    expense_dispute_resolved: {
      title: 'உங்கள் திருத்தத்திற்கு பதில் வந்தது',
      body: '{description} ({group})',
    },
    ghost_claim_requested: {
      title: '{group} இல் சேர ஒருவர் கேட்கிறார்',
      body: 'தாங்கள் {name} என்கிறார். நீங்கள் உறுதி செய்யும் வரை எதுவும் மாறாது.',
    },
    ghost_claim_approved: {
      title: 'நீங்கள் {group} இல் சேர்ந்துவிட்டீர்கள்',
      body: '{name} பெயரில் ஏற்கனவே பதிவானவை அனைத்தும் இப்போது உங்களுடையவை',
    },
    ghost_claim_declined: {
      title: 'உறுதி செய்யப்படவில்லை',
      body: '{group} அந்த இடத்தை உறுதி செய்யவில்லை. நீங்களாகவே சேரலாம்.',
    },
  },
  email: {
    confirmAction: 'கிடைத்தது என உறுதிப்படுத்தவும்',
    openAction: 'பாக்கியைத் திறக்கவும்',
    why: 'பாக்கியில் {group} காரணமாக இந்த மின்னஞ்சல் வந்துள்ளது.',
    unsubscribe: 'இதுபோன்ற மின்னஞ்சல்களை நிறுத்தவும்',
    signature: 'பாக்கி',
  },
};

const hi: CopyStrings = {
  money: {
    owedToYou: 'आपको {amount} मिलने हैं',
    youOwe: 'आपको {amount} देने हैं',
    settled: 'सब हिसाब बराबर',
    netPositive: 'कुल मिलाकर आपको {amount} मिलने हैं',
    netNegative: 'आपकी बाकी {amount} है',
  },
  notifications: {
    expense_added: { title: '{actor} ने खर्च जोड़ा', body: '{description} · {amount} ({group})' },
    expense_edited: { title: '{actor} ने खर्च बदला', body: '{description} ({group})' },
    expense_deleted: { title: '{actor} ने खर्च हटाया', body: '{description} ({group})' },
    you_owe: { title: 'आपको {amount} देने हैं', body: '{description} ({group})' },
    settlement_initiated: { title: '{actor} ने आपको {amount} भेजे', body: 'मिलने की पुष्टि करें' },
    settlement_confirm_request: {
      title: '{actor} कहते हैं उन्होंने {amount} भेजे',
      body: 'पुष्टि करें ताकि बाकी सही रहे',
    },
    settlement_confirmed: { title: '{actor} के साथ हिसाब बराबर', body: '{amount} ({group})' },
    nudge: { title: '{actor} की ओर से एक याद', body: '{group} में {amount} बाकी' },
    ghost_claimed: { title: '{actor} {group} में शामिल हुए', body: 'पुराने खर्च जुड़ गए' },
    group_invite_accepted: { title: '{actor} {group} में शामिल हुए', body: 'नमस्ते कहें' },
    digest_daily: { title: 'आज {group} में', body: '{count} अपडेट · बाकी {amount}' },
    trip_nudge_morning: {
      title: 'कल का कुछ बाकी है?',
      body: 'याद रहते ही {group} के खर्च जोड़ दें',
    },
    trip_nudge_evening: {
      title: 'भूलने से पहले',
      body: 'आज {group} में आपने किस चीज़ का भुगतान किया?',
    },
    expense_disputed: {
      title: '{actor} को कुछ गड़बड़ लग रहा है',
      body: '{description} ({group}) — देख लें',
    },
    expense_dispute_resolved: {
      title: 'आपके सुधार का जवाब आया',
      body: '{description} ({group})',
    },
    ghost_claim_requested: {
      title: '{group} में कोई शामिल होना चाहता है',
      body: 'उनका कहना है कि वे {name} हैं। आपकी पुष्टि तक कुछ नहीं बदलेगा।',
    },
    ghost_claim_approved: {
      title: 'आप {group} में हैं',
      body: '{name} के नाम पर जो कुछ पहले से दर्ज है, वह अब आपका है',
    },
    ghost_claim_declined: {
      title: 'पुष्टि नहीं हुई',
      body: '{group} ने वह जगह पक्की नहीं की। आप अपने नाम से शामिल हो सकते हैं।',
    },
  },
  email: {
    confirmAction: 'मिलने की पुष्टि करें',
    openAction: 'बाकी खोलें',
    why: 'यह मेल बाकी पर {group} की वजह से आया है।',
    unsubscribe: 'ऐसे मेल बंद करें',
    signature: 'बाकी',
  },
};

const ar: CopyStrings = {
  money: {
    owedToYou: 'لك {amount}',
    youOwe: 'عليك {amount}',
    settled: 'تمت التسوية',
    netPositive: 'لك {amount} في المجمل',
    netNegative: 'باقيك {amount}',
  },
  notifications: {
    expense_added: {
      title: 'أضاف {actor} مصروفًا',
      body: '{description} · {amount} في {group}',
    },
    expense_edited: { title: 'عدّل {actor} مصروفًا', body: '{description} في {group}' },
    expense_deleted: { title: 'حذف {actor} مصروفًا', body: '{description} في {group}' },
    you_owe: { title: 'عليك {amount}', body: '{description} في {group}' },
    settlement_initiated: {
      title: 'دفع لك {actor} مبلغ {amount}',
      body: 'اضغط لتأكيد استلامه',
    },
    settlement_confirm_request: {
      title: 'يقول {actor} إنه دفع لك {amount}',
      body: 'أكّد حتى يبقى باقيك صحيحًا',
    },
    settlement_confirmed: { title: 'تمت التسوية مع {actor}', body: '{amount} في {group}' },
    nudge: { title: 'تذكير لطيف من {actor}', body: '{amount} معلّقة في {group}' },
    ghost_claimed: { title: 'انضم {actor} إلى {group}', body: 'رُبطت مصروفاته السابقة' },
    group_invite_accepted: { title: 'انضم {actor} إلى {group}', body: 'ألقِ التحية' },
    digest_daily: { title: 'اليوم في {group}', body: '{count} تحديثات · باقيك {amount}' },
    trip_nudge_morning: {
      title: 'هل بقي شيء من الأمس؟',
      body: 'أضف ما أنفقته على {group} ما دمت تتذكره',
    },
    trip_nudge_evening: {
      title: 'قبل أن تنسى',
      body: 'ماذا دفعت اليوم في {group}؟',
    },
    expense_disputed: {
      title: 'يرى {actor} أن هناك خطأً',
      body: '{description} في {group} — ألقِ نظرة',
    },
    expense_dispute_resolved: {
      title: 'وصل ردّ على تصحيحك',
      body: '{description} في {group}',
    },
    ghost_claim_requested: {
      title: 'أحدهم يريد الانضمام إلى {group}',
      body: 'يقول إنه {name}. لا يتغيّر شيء حتى تؤكّد.',
    },
    ghost_claim_approved: {
      title: 'أنت الآن في {group}',
      body: 'كل ما سُجّل باسم {name} صار لك',
    },
    ghost_claim_declined: {
      title: 'لم يتم التأكيد',
      body: 'لم تؤكّد {group} ذلك المكان. ما زال بإمكانك الانضمام باسمك.',
    },
  },
  email: {
    confirmAction: 'أكّد استلامك للمبلغ',
    openAction: 'افتح باقي',
    why: 'وصلك هذا البريد بسبب {group} في باقي.',
    unsubscribe: 'أوقف هذه الرسائل',
    signature: 'باقي',
  },
};

export const COPY: Readonly<Record<LanguageCode, CopyStrings>> = { en, ta, hi, ar };

export function copyFor(language: string): CopyStrings {
  const base = language.slice(0, 2).toLowerCase() as LanguageCode;
  return COPY[base] ?? en;
}

export function interpolate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
