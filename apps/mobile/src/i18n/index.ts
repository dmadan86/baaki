/**
 * i18n scaffolding from day one (TDR §11): en + ta + hi, with locale-aware
 * money and date formatting everywhere. Notification copy lives in
 * @baaki/core/notifications so the server sends the same words.
 */

import { getLocales } from 'expo-localization';

import type { CategoryId } from '@baaki/core';

export type Language = 'en' | 'ta' | 'hi';

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

const STRINGS: Record<Language, UiStrings> = { en, ta, hi };

export function deviceLanguage(): Language {
  const tag = getLocales()[0]?.languageCode ?? 'en';
  return tag === 'ta' || tag === 'hi' ? tag : 'en';
}

export function deviceLocale(): string {
  return getLocales()[0]?.languageTag ?? 'en-IN';
}

export function useStrings(): { t: UiStrings; locale: string; language: Language } {
  const language = deviceLanguage();
  return { t: STRINGS[language], locale: deviceLocale(), language };
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
}
