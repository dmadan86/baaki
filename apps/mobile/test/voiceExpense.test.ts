import { describe, expect, it } from 'vitest';

import {
  matchMemberNames,
  parseVoiceCategory,
  parseVoiceExpense,
  parseVoiceExpenseDate,
  resolveVoiceParticipants,
  type VoiceGroupRef,
} from '@/lib/voiceExpense';

const groups: VoiceGroupRef[] = [
  { id: 'g-goa', name: 'Goa Trip' },
  { id: 'g-flat', name: 'Flat 4B' },
  { id: 'g-unnamed', name: null },
];

describe('parseVoiceExpense', () => {
  it('pulls the amount and converts to minor units', () => {
    const parsed = parseVoiceExpense('add 500 rupees to the Goa trip', groups);
    expect(parsed.amountMajor).toBe(500);
    expect(parsed.amountMinor).toBe(50000n);
    expect(parsed.currency).toBe('INR');
  });

  it('parses a polite, conversational request and keeps the note clean', () => {
    // "hello, can you please add five hundred rupees for tea shop" — greeting +
    // request framing wrap the real command. The amount and currency still come
    // through, and the filler ("can you please add … for") is stripped so the
    // note is just what it was spent on.
    const parsed = parseVoiceExpense(
      'hello, can you please add five hundred rupees for tea shop',
      groups,
    );
    expect(parsed.amountMajor).toBe(500);
    expect(parsed.amountMinor).toBe(50000n);
    expect(parsed.currency).toBe('INR');
    expect(parsed.note).toBe('tea shop');
  });

  it('matches the group the sentence names', () => {
    expect(parseVoiceExpense('add 500 to Goa trip', groups).groupId).toBe('g-goa');
    expect(parseVoiceExpense('200 for flat', groups).groupId).toBe('g-flat');
  });

  it('leaves the group null when nothing is named', () => {
    expect(parseVoiceExpense('add 500 rupees', groups).groupId).toBeNull();
  });

  it('handles assignment phrasing and keeps it out of the note', () => {
    const withTest: VoiceGroupRef[] = [...groups, { id: 'g-test', name: 'Test One' }];
    // "assign to group X", the amount and the T-shirt description, plus the
    // routing verbs, all resolve: group matched, note is just the description.
    const assign = parseVoiceExpense('500 rupees t shirt assign to group test one', withTest);
    expect(assign.groupId).toBe('g-test');
    expect(assign.amountMinor).toBe(50000n);
    expect(assign.note).toBe('t shirt');

    // "put it in <group>" and "in this group <group>" are the same intent.
    expect(parseVoiceExpense('200 for lunch put it in Goa trip', groups).groupId).toBe('g-goa');
    const inThis = parseVoiceExpense('300 snacks in this group Goa trip', groups);
    expect(inThis.groupId).toBe('g-goa');
    expect(inThis.note).toBe('snacks');
  });

  it('routing cleanup is phrase-aware, not a blanket word drop', () => {
    // A group literally named after a routing word still matches — the words are
    // only filler inside a recognised routing phrase, not everywhere.
    const named: VoiceGroupRef[] = [
      { id: 'g-it', name: 'IT' },
      { id: 'g-this', name: 'This' },
      { id: 'g1', name: 'Group 1' },
      { id: 'g-proj1', name: 'Project 1' },
    ];
    expect(parseVoiceExpense('500 lunch for IT', named).groupId).toBe('g-it');
    expect(parseVoiceExpense('500 lunch for This', named).groupId).toBe('g-this');
    // "assign to group 1" keeps "Group 1" whole, so it is not confused with
    // "Project 1" (both would tie on a bare "1" if "group" were dropped here).
    expect(parseVoiceExpense('500 t shirt assign to group 1', named).groupId).toBe('g1');

    // An ordinary description keeps words like "this" when no routing phrase is
    // present.
    expect(parseVoiceExpense('500 for this lunch', groups).note).toBe('this lunch');
  });

  it('leaves the group null when the name is ambiguous', () => {
    const twoTrips: VoiceGroupRef[] = [
      { id: 'a', name: 'Goa Trip' },
      { id: 'b', name: 'Manali Trip' },
    ];
    // Only "trip" is shared, and both score on it — a tie is treated as no match.
    expect(parseVoiceExpense('add 500 for the trip', twoTrips).groupId).toBeNull();
  });

  it('keeps the description and drops amount, currency, group and filler', () => {
    const parsed = parseVoiceExpense('add 1200 rupees for dinner on the Goa trip', groups);
    expect(parsed.note).toBe('dinner');
    expect(parsed.amountMinor).toBe(120000n);
    expect(parsed.groupId).toBe('g-goa');
  });

  it('handles thousands separators and decimals', () => {
    const parsed = parseVoiceExpense('spent 1,299.50 dollars', groups);
    expect(parsed.amountMajor).toBe(1299.5);
    expect(parsed.amountMinor).toBe(129950n);
    expect(parsed.currency).toBe('USD');
  });

  it('scales minor units by the currency exponent, not a flat 100', () => {
    // JPY is zero-decimal: ¥3000 is 3000 minor units, not 300000.
    const jpy = parseVoiceExpense('¥3000 ramen', groups);
    expect(jpy.currency).toBe('JPY');
    expect(jpy.amountMajor).toBe(3000);
    expect(jpy.amountMinor).toBe(3000n);
    // Two-decimal currencies are unchanged.
    expect(parseVoiceExpense('500 rupees', groups).amountMinor).toBe(50000n);
  });

  it('reads a spoken amount before a three-word currency name', () => {
    const cases: [string, number, string][] = [
      ['five hundred sri lankan rupees tea', 500, 'LKR'],
      ['six hundred new zealand dollars tour', 600, 'NZD'],
      ['three hundred hong kong dollars dinner', 300, 'HKD'],
    ];
    for (const [sentence, major, code] of cases) {
      const parsed = parseVoiceExpense(sentence, groups);
      expect(parsed.amountMajor).toBe(major);
      expect(parsed.currency).toBe(code);
    }
  });

  it('recognises currencies beyond rupees and dollars', () => {
    const cases: [string, string][] = [
      ['2000 yen for sushi', 'JPY'],
      ['2000 JPY for sushi', 'JPY'],
      ['50 euro hotel', 'EUR'],
      ['50 euros hotel', 'EUR'],
      ['50 EUR hotel', 'EUR'],
      ['100 pounds tickets', 'GBP'],
      ['100 sterling tickets', 'GBP'],
      ['100 quid tickets', 'GBP'],
      ['100 GBP tickets', 'GBP'],
      ['300 dirhams taxi', 'AED'],
      ['300 dirham taxi', 'AED'],
      ['300 AED taxi', 'AED'],
      ['5000 won lunch', 'KRW'],
      ['5000 KRW lunch', 'KRW'],
      ['100 yuan noodles', 'CNY'],
      ['100 renminbi noodles', 'CNY'],
      ['100 RMB noodles', 'CNY'],
      ['100 CNY noodles', 'CNY'],
      ['1000 ringgit shopping', 'MYR'],
      ['1000 MYR shopping', 'MYR'],
      ['200 baht food', 'THB'],
      ['200 THB food', 'THB'],
      ['500 dong snacks', 'VND'],
      ['500 VND snacks', 'VND'],
      ['100000 rupiah dinner', 'IDR'],
      ['100000 rupiahs dinner', 'IDR'],
      ['100000 Indonesian rupiahs dinner', 'IDR'],
      ['100000 IDR dinner', 'IDR'],
      ['Rp 100000 dinner', 'IDR'],
      ['Rp. 100000 dinner', 'IDR'],
      ['Rp100000 dinner', 'IDR'],
      ['IDR100000 dinner', 'IDR'],
      ['80 francs cab', 'CHF'],
      ['80 CHF cab', 'CHF'],
      ['500 canadian dollars flight', 'CAD'],
      ['500 CAD flight', 'CAD'],
      ['600 australian dollars tour', 'AUD'],
      ['600 AUD tour', 'AUD'],
      ['sri lankan rupees 400 tea', 'LKR'],
      ['400 LKR tea', 'LKR'],
      ['400 nepali rupees tea', 'NPR'],
      ['400 NPR tea', 'NPR'],
      ['400 pakistani rupees tea', 'PKR'],
      ['400 PKR tea', 'PKR'],
      ['50 singapore dollars snacks', 'SGD'],
      ['50 SGD snacks', 'SGD'],
      ['60 new zealand dollars tour', 'NZD'],
      ['60 NZD tour', 'NZD'],
      ['70 hong kong dollars dinner', 'HKD'],
      ['70 HKD dinner', 'HKD'],
      ['90 mexican pesos tacos', 'MXN'],
      ['90 pesos tacos', 'MXN'],
      ['90 MXN tacos', 'MXN'],
      ['120 philippine pesos ferry', 'PHP'],
      ['120 PHP ferry', 'PHP'],
      ['30 saudi riyals coffee', 'SAR'],
      ['30 riyal coffee', 'SAR'],
      ['30 SAR coffee', 'SAR'],
      ['40 south african rand taxi', 'ZAR'],
      ['40 rands taxi', 'ZAR'],
      ['40 ZAR taxi', 'ZAR'],
      ['500 bangladeshi taka lunch', 'BDT'],
      ['500 takas lunch', 'BDT'],
      ['500 BDT lunch', 'BDT'],
      ['25 brazilian reais dinner', 'BRL'],
      ['25 reals dinner', 'BRL'],
      ['25 BRL dinner', 'BRL'],
      ['10 turkish lira coffee', 'TRY'],
      ['10 Turkish liras coffee', 'TRY'],
      ['10 TRY coffee', 'TRY'],
      ['700 rubles train', 'RUB'],
      ['700 roubles train', 'RUB'],
      ['700 RUB train', 'RUB'],
      // Cents folded in must not demote the qualified name to a bare-dollar USD
      ['twenty canadian dollars ninety nine cents', 'CAD'],
    ];
    for (const [sentence, code] of cases) {
      expect(parseVoiceExpense(sentence, groups).currency).toBe(code);
    }
  });

  it('reads currency symbols', () => {
    const cases: [string, string, number][] = [
      ['¥3000 ramen', 'JPY', 3000],
      ['$25 coffee', 'USD', 2500],
      ['€15 museum', 'EUR', 1500],
      ['£12 tickets', 'GBP', 1200],
      ['₹500 chai', 'INR', 50000],
      ['₺10 coffee', 'TRY', 1000],
      ['₩5000 lunch', 'KRW', 5000],
      ['₫20000 snacks', 'VND', 20000],
      ['฿200 food', 'THB', 20000],
      ['₦1200 cab', 'NGN', 120000],
      ['₱120 ferry', 'PHP', 12000],
      ['₽700 train', 'RUB', 70000],
      ['R$25 dinner', 'BRL', 2500],
    ];
    for (const [sentence, code, minor] of cases) {
      const parsed = parseVoiceExpense(sentence, groups);
      expect(parsed.currency, sentence).toBe(code);
      expect(parsed.amountMinor, sentence).toBe(BigInt(minor));
    }
  });

  it('strips expanded currency words and symbols out of the note', () => {
    expect(parseVoiceExpense('100 sterling tickets', groups).note).toBe('tickets');
    expect(parseVoiceExpense('100 yuan noodles', groups).note).toBe('noodles');
    expect(parseVoiceExpense('120 PHP ferry', groups).note).toBe('ferry');
    expect(parseVoiceExpense('R$25 dinner', groups).note).toBe('dinner');
    expect(parseVoiceExpense('30 saudi riyals coffee', groups).note).toBe('coffee');
  });

  it('does not mint a currency from the ordinary word "try"', () => {
    expect(parseVoiceExpense("I'll try the new place, 500 rupees", groups).currency).toBe('INR');
  });

  it('returns nulls for a sentence with no number', () => {
    const parsed = parseVoiceExpense('groceries for the flat', groups);
    expect(parsed.amountMinor).toBeNull();
    expect(parsed.amountMajor).toBeNull();
    expect(parsed.groupId).toBe('g-flat');
    expect(parsed.note).toBe('groceries');
  });

  it('does not create an expense from unsupported negative, repayment, or refund intents', () => {
    for (const sentence of [
      "don't add 500 rupees for dinner",
      'don’t add 500 rupees for dinner',
      'cancel 500 rupees dinner',
      'refund 200 rupees hotel',
      'Ravi paid me back 500 rupees',
      'I did not pay 500 rupees for dinner',
      "I didn't pay 500 rupees for dinner",
      'I didn’t pay 500 rupees for dinner',
      'Ravi repaid 500 rupees',
      'Ravi repayment 500 rupees',
      'Ravi reimbursed me 500 rupees',
      'got paid back 500 rupees',
      'received money back 500 rupees',
    ]) {
      const parsed = parseVoiceExpense(sentence, groups);
      expect(parsed.amountMajor, sentence).toBeNull();
      expect(parsed.amountMinor, sentence).toBeNull();
      expect(parsed.note, sentence).toBe('');
    }
  });

  it('rejects negative signed and spoken amounts in currency-adjacent and fallback positions', () => {
    for (const sentence of [
      '-500 rupees dinner',
      '₹-500 dinner',
      'minus -500 dinner',
      'minus five hundred rupees dinner',
      'negative twenty dollars cab',
    ]) {
      const parsed = parseVoiceExpense(sentence, groups);
      expect(parsed.amountMajor, sentence).toBeNull();
      expect(parsed.amountMinor, sentence).toBeNull();
    }
    expect(parseVoiceExpense('+500 rupees dinner', groups).amountMajor).toBe(500);
  });

  it('rejects unsafe huge amounts instead of converting them to imprecise minor units', () => {
    const parsed = parseVoiceExpense('999999999999999999 rupees', groups);
    expect(parsed.amountMajor).toBeNull();
    expect(parsed.amountMinor).toBeNull();
  });

  it('normalizes Unicode group names before matching and note cleanup', () => {
    const accented: VoiceGroupRef[] = [{ id: 'g-cafe', name: 'Café Trip' }];
    const parsed = parseVoiceExpense('add 500 to Café Trip', accented);
    expect(parsed.groupId).toBe('g-cafe');
    expect(parsed.note).toBe('');
  });

  it('reads a currency symbol', () => {
    expect(parseVoiceExpense('₹750 taxi', groups).currency).toBe('INR');
    expect(parseVoiceExpense('$40 lunch', groups).currency).toBe('USD');
  });

  it('reads a split count without mistaking it for the amount', () => {
    const parsed = parseVoiceExpense('split 500 rupees among 3 people for dinner', groups);
    expect(parsed.amountMajor).toBe(500);
    expect(parsed.splitCount).toBe(3);
    expect(parsed.note).toBe('dinner');
  });

  it('takes the amount from the currency, even when the count comes first', () => {
    const parsed = parseVoiceExpense('split among 4 people, 800 rupees dinner', groups);
    expect(parsed.amountMajor).toBe(800);
    expect(parsed.splitCount).toBe(4);
  });

  it('reads "N ways" as the count', () => {
    expect(parseVoiceExpense('300 split 3 ways', groups).splitCount).toBe(3);
    expect(parseVoiceExpense('300 split 3 ways', groups).amountMajor).toBe(300);
  });

  it('reads a spoken split count ("split among five")', () => {
    const parsed = parseVoiceExpense('five hundred rupees dinner split among five', groups);
    expect(parsed.amountMajor).toBe(500);
    expect(parsed.splitCount).toBe(5);
  });

  it('reads a spoken "five people" count', () => {
    const parsed = parseVoiceExpense('five hundred rupees dinner for five people', groups);
    expect(parsed.amountMajor).toBe(500);
    expect(parsed.splitCount).toBe(5);
  });

  it('leaves the count null when no split is said', () => {
    expect(parseVoiceExpense('add 500 for dinner', groups).splitCount).toBeNull();
  });

  // How real people actually say amounts out loud — proper English and not —
  // captured as one table so a phrasing that regresses is obvious. Each row is
  // [sentence, expected major amount].
  describe('the many ways a person speaks an amount', () => {
    const amountCases: [string, number][] = [
      // Whole numbers in words
      ['hundred rupees for coffee', 100],
      ['one hundred rupees coffee', 100],
      ['five hundred and fifty rupees', 550],
      ['thousand rupees petrol', 1000],
      ['fifteen hundred rupees hotel', 1500],
      ['twenty five hundred rupees flight', 2500],
      ['thousand five hundred rupees', 1500],
      ['lakh rupees rent', 100000],
      // Digit joined to a spoken scale word (common dictation output)
      ['3 thousand rupees petrol', 3000],
      ['5 lakh for the car', 500000],
      ['2 crore rupees flat', 20000000],
      // Spoken decimals — "point" and, less often, "dot"
      ['hundred point five rupees snacks', 100.5],
      ['hundred dot five rupees snacks', 100.5],
      ['ninety nine point nine nine rupees', 99.99],
      ['one hundred point five zero dollars', 100.5],
      ['point five zero rupees tip', 0.5],
      // Minor units spoken out — paise and cents
      ['hundred rupees fifty paise milk', 100.5],
      ['hundred rupees and fifty paise milk', 100.5],
      ['twenty dollars ninety nine cents', 20.99],
      // A qualified name must fold its cents too, not drop them
      ['twenty canadian dollars ninety nine cents', 20.99],
      ['five rupees five paise', 5.05],
      // Written digits with separators and decimals
      ['1,299.50 dollars', 1299.5],
      ['99.99 dollars', 99.99],
      // Currency named before the amount
      ['rupees hundred for auto', 100],
      ['$40 for lunch', 40],
      // Not-so-proper English word order — the amount still comes through
      ['petrol 100 rupees', 100],
      ['i paid 500 rupees for dinner', 500],
      ['dinner 250 rupees me and two friends', 250],
    ];
    for (const [sentence, expected] of amountCases) {
      it(`hears "${sentence}" as ${expected}`, () => {
        expect(parseVoiceExpense(sentence, groups).amountMajor).toBe(expected);
      });
    }
  });

  // The flip side: phrasings a person did NOT mean as an amount must stay null,
  // so the screen asks rather than inventing money out of ordinary speech.
  describe('phrasings that must NOT become an amount', () => {
    const noAmount = [
      'groceries for the flat',
      'table for two please',
      'split it between us',
      'one of us will pay later',
    ];
    for (const sentence of noAmount) {
      it(`hears no amount in "${sentence}"`, () => {
        expect(parseVoiceExpense(sentence, groups).amountMajor).toBeNull();
      });
    }
  });
});

describe('matchMemberNames', () => {
  const members = [
    { id: 'm-me', name: 'You' },
    { id: 'm-ravi', name: 'Ravi' },
    { id: 'm-priya', name: 'Priya Nair' },
    { id: 'm-sam', name: 'Sam' },
  ];

  it('picks the members the sentence names', () => {
    expect(matchMemberNames('split dinner with Ravi and Priya', members)).toEqual([
      'm-ravi',
      'm-priya',
    ]);
  });

  it('matches on any word of a full name', () => {
    expect(matchMemberNames('300 for Nair', members)).toEqual(['m-priya']);
  });

  it('returns nothing when no one is named', () => {
    expect(matchMemberNames('add 500 for dinner', members)).toEqual([]);
  });

  it('resolves named voice participants and keeps the payer included', () => {
    expect(
      resolveVoiceParticipants({
        all: members.map((member) => member.id),
        payer: 'm-me',
        members,
        peopleText: '800 dinner split with Ravi and Priya',
        splitCount: 3,
      }),
    ).toEqual(['m-ravi', 'm-priya', 'm-me']);
    expect(
      resolveVoiceParticipants({
        all: members.map((member) => member.id),
        payer: 'm-me',
        members,
        peopleText: 'split 800 dinner with Ravi and Priya',
        splitCount: 3,
      }),
    ).toEqual(['m-ravi', 'm-priya', 'm-me']);
  });

  it('does not narrow participants when names appear outside an explicit split clause', () => {
    const all = members.map((member) => member.id);
    expect(
      resolveVoiceParticipants({
        all,
        payer: 'm-me',
        members,
        peopleText: "1000 rupees for Priya's birthday dinner",
        splitCount: null,
      }),
    ).toEqual(all);
  });

  it('falls back to all members when a split count names nobody or conflicts', () => {
    const all = members.map((member) => member.id);
    expect(
      resolveVoiceParticipants({ all, payer: 'm-me', members, peopleText: null, splitCount: 2 }),
    ).toEqual(all);
    expect(
      resolveVoiceParticipants({
        all,
        payer: 'm-me',
        members,
        peopleText: '800 dinner split with Ravi and Priya',
        splitCount: 2,
      }),
    ).toEqual(all);
  });
});

import { detectCreateGroup, normalizeDigits, parseVoiceExpenses } from '@/lib/voiceExpense';

describe('parseVoiceExpenses (several in one breath)', () => {
  it('splits a comma-and-and list into one expense each', () => {
    const result = parseVoiceExpenses(
      '5 rupees for snacks, 10 rupee for tea, shopping 1000, others 100',
      groups,
    );
    expect(result.items.map((item) => item.amountMajor)).toEqual([5, 10, 1000, 100]);
    expect(result.items.map((item) => item.note)).toEqual(['snacks', 'tea', 'shopping', 'others']);
  });

  it('carries a currency named once to the later items that name none', () => {
    const result = parseVoiceExpenses('5 rupees snacks, 10 tea, 20 cab', groups);
    expect(result.items.every((item) => item.currency === 'INR')).toBe(true);
  });

  it('keeps a lone expense working, with its named group', () => {
    const result = parseVoiceExpenses('add 500 rupees for dinner on the Goa trip', groups);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(500);
    expect(result.items[0].note).toBe('dinner');
    expect(result.group).toEqual({ kind: 'existing', groupId: 'g-goa' });
  });

  it('reads a create-group instruction and still files the expenses', () => {
    const result = parseVoiceExpenses('make a group called Weekend and add 200 for lunch', groups);
    expect(result.group).toEqual({ kind: 'create', name: 'Weekend' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(200);
    expect(result.items[0].note).toBe('lunch');
  });

  it('keeps with inside a created group name', () => {
    const result = parseVoiceExpenses(
      'make a group called Friends with Kids and add 200 for lunch',
      groups,
    );
    expect(result.group).toEqual({ kind: 'create', name: 'Friends with Kids' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].note).toBe('lunch');
  });

  it('drops segments that carry no amount', () => {
    const result = parseVoiceExpenses('hello, 50 for coffee, um', groups);
    expect(result.items.map((item) => item.amountMajor)).toEqual([50]);
  });

  it('strips a greeting and filler fused to the amount, not into the note', () => {
    const result = parseVoiceExpenses(
      'hello, uh, add 500 rupees for dinner on the Goa trip',
      groups,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(500);
    expect(result.items[0].note).toBe('dinner');
    expect(result.group).toEqual({ kind: 'existing', groupId: 'g-goa' });
  });

  it('reads an expense that opens with a greeting', () => {
    const result = parseVoiceExpenses('hi 300 rupees petrol', groups);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(300);
    expect(result.items[0].note).toBe('petrol');
  });

  // Dictation often hands back a digit glued to a spoken scale word — "3
  // thousand", "5 lakh", "2 crore" — rather than the fully-spelled words or the
  // finished digits. These must fold to one amount, not split into a phantom
  // "₹3" expense plus a "₹1000" one (the bug that made "three thousand rupees
  // for petrol" save as ₹3 with no description).
  it('folds a digit joined to a scale word into one amount', () => {
    const result = parseVoiceExpenses('3 thousand rupees for petrol', groups);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(3000);
    expect(result.items[0].note).toBe('petrol');
    expect(result.items[0].currency).toBe('INR');
  });

  it('folds Indian scale words (lakh, crore) onto a leading digit', () => {
    expect(parseVoiceExpenses('5 lakh for car', groups).items[0].amountMajor).toBe(500000);
    expect(parseVoiceExpenses('2 crore rupees', groups).items[0].amountMajor).toBe(20000000);
  });

  it('folds a fully-spoken scale amount too', () => {
    const result = parseVoiceExpenses('three thousand rupees for petrol', groups);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(3000);
    expect(result.items[0].note).toBe('petrol');
  });

  it('still splits a bare run of digits into separate expenses (5 10 ≠ 15)', () => {
    const result = parseVoiceExpenses('5 rupees snacks 10 rupees tea', groups);
    expect(result.items.map((item) => item.amountMajor)).toEqual([5, 10]);
  });

  it('assigns the named group even with "split equally" phrasing', () => {
    const result = parseVoiceExpenses('split equally for the Goa trip 3000 rupees', groups);
    expect(result.group).toEqual({ kind: 'existing', groupId: 'g-goa' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(3000);
    expect(result.items[0].currency).toBe('INR');
  });

  it('assigns the group and reads a people-count in one breath', () => {
    const result = parseVoiceExpenses('1000 rupees groceries on Goa trip split among 4', groups);
    expect(result.group).toEqual({ kind: 'existing', groupId: 'g-goa' });
    expect(result.splitCount).toBe(4);
    expect(result.items[0].amountMajor).toBe(1000);
  });

  it('carries split names for downstream matching without leaking them into the note', () => {
    const result = parseVoiceExpenses(
      '800 rupees dinner on Goa trip split with Ravi and Priya',
      groups,
    );
    expect(result.peopleText).toBe('800 rupees dinner on Goa trip split with Ravi and Priya');
    expect(result.items[0].note).toBe('dinner');
  });

  it('carries non-rupee currencies through the multi-expense path', () => {
    const result = parseVoiceExpenses('20 euros coffee, 15 euros cake', groups);
    expect(result.items.map((item) => item.currency)).toEqual(['EUR', 'EUR']);
    expect(result.items.map((item) => item.amountMajor)).toEqual([20, 15]);
  });

  it('backfills a single named currency to earlier bare items', () => {
    const result = parseVoiceExpenses('5 snacks, 10 rupees tea', groups);
    expect(result.items.map((item) => item.currency)).toEqual(['INR', 'INR']);
    expect(result.items.map((item) => item.amountMinor)).toEqual([500n, 1000n]);
  });

  it('carries deterministic spoken dates without leaking them into notes', () => {
    const result = parseVoiceExpenses('500 rupees dinner yesterday', groups);
    expect(result.expenseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.items[0].note).toBe('dinner');
  });

  it('reads explicit ISO dates and rejects impossible dates', () => {
    const result = parseVoiceExpenses('500 rupees dinner on 2026-08-12', groups);
    expect(result.expenseDate).toBe('2026-08-12');
    expect(result.items[0].note).toBe('dinner');
    expect(parseVoiceExpenseDate('dinner on 2026-02-30')).toBeNull();
  });

  it('reads explicit built-in category phrases without leaking them into notes', () => {
    const result = parseVoiceExpenses('500 rupees airport cab category travel', groups);
    expect(result.items[0].category).toBe('travel');
    expect(result.items[0].note).toBe('airport cab');
    expect(parseVoiceCategory('tag as food')).toBe('food');
  });

  it('keeps explicit categories item-specific in multi-expense transcripts', () => {
    const result = parseVoiceExpenses(
      '500 rupees airport cab category travel, 300 rupees dinner tag food',
      groups,
    );
    expect(result.items.map((item) => item.category)).toEqual(['travel', 'food']);
    expect(result.items.map((item) => item.note)).toEqual(['airport cab', 'dinner']);
  });

  it('uses a trailing category as a global fallback when items do not name one', () => {
    const result = parseVoiceExpenses('500 rupees cab, 300 rupees bus category travel', groups);
    expect(result.items.map((item) => item.category)).toEqual(['travel', 'travel']);
  });

  it('ignores unknown category phrases safely', () => {
    const result = parseVoiceExpenses('500 rupees dinner category crypto', groups);
    expect(result.items[0].category).toBeNull();
    expect(result.items[0].note).toBe('dinner');
  });

  it('does not create items from unsupported negative, repayment, refund, or third-party payer intents', () => {
    for (const sentence of [
      "don't add 500 rupees for dinner",
      'don’t add 500 rupees for dinner',
      'delete 500 rupees dinner',
      'refund 200 rupees hotel',
      'Ravi paid me back 500 rupees',
      'Ravi paid 500 rupees for dinner',
      'Priya paid twenty dollars for cab',
      'I did not pay 500 rupees for dinner',
      "I didn't pay 500 rupees for dinner",
      'I didn’t pay 500 rupees for dinner',
      'Ravi repaid 500 rupees',
      'Ravi repayment 500 rupees',
      'Ravi reimbursed me 500 rupees',
      'got paid back 500 rupees',
      'received money back 500 rupees',
    ]) {
      expect(parseVoiceExpenses(sentence, groups).items, sentence).toEqual([]);
    }
    expect(parseVoiceExpenses('I paid 500 rupees for dinner', groups).items).toHaveLength(1);
  });

  it('keeps safe expenses while skipping unsupported neighbouring clauses', () => {
    const result = parseVoiceExpenses(
      '500 rupees dinner, Ravi paid me back 200 rupees, 300 rupees cab, Priya paid 50 rupees snacks',
      groups,
    );
    expect(result.items.map((item) => item.amountMajor)).toEqual([500, 300]);
    expect(result.items.map((item) => item.note)).toEqual(['dinner', 'cab']);
  });

  it('still rejects global removal commands instead of partially parsing them', () => {
    expect(parseVoiceExpenses('delete 500 rupees dinner and 300 rupees cab', groups).items).toEqual(
      [],
    );
  });

  it('does not create items from signed or spoken negative amounts', () => {
    for (const sentence of [
      '-500 rupees dinner',
      '₹-500 dinner',
      'minus -500 dinner',
      'minus five hundred rupees dinner',
      'negative twenty dollars cab',
    ]) {
      expect(parseVoiceExpenses(sentence, groups).items, sentence).toEqual([]);
    }
    expect(parseVoiceExpenses('+500 rupees dinner', groups).items[0]?.amountMajor).toBe(500);
  });

  it('does not reject non-amount uses of negative or minus', () => {
    expect(parseVoiceExpenses('500 rupees negative test kit', groups).items[0]?.note).toBe(
      'negative test kit',
    );
    expect(parseVoiceExpenses('300 rupees minus screwdriver', groups).items[0]?.note).toBe(
      'minus screwdriver',
    );
  });

  it('does not sum mixed-currency plus runs into one cross-currency amount', () => {
    const result = parseVoiceExpenses('20 dollars plus 50 rupees', groups);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.amountMajor)).toEqual([20, 50]);
    expect(result.items.map((item) => item.currency)).toEqual(['USD', 'INR']);
  });
});

// An Indian-English speaker often dictates an amount digit-by-digit, and speech-
// to-text renders the spoken zero as "oh"/"naught"/"nought" — and, mangled, as
// "not". "two oh five rupees" means ₹205, not 2 + 0 + 5.
describe('a spoken digit-by-digit amount', () => {
  it('reads "two oh five rupees" as 205', () => {
    const parsed = parseVoiceExpense('two oh five rupees', groups);
    expect(parsed.amountMajor).toBe(205);
    expect(parsed.currency).toBe('INR');
    // Still scales to minor units the currency-aware way.
    expect(parsed.amountMinor).toBe(20500n);
  });

  it('reads "naught" and "nought" as the spoken zero', () => {
    expect(parseVoiceExpense('two naught five rupees', groups).amountMajor).toBe(205);
    expect(parseVoiceExpense('two nought five rupees', groups).amountMajor).toBe(205);
  });

  it('reads a "not" the STT wrote for a spoken zero, inside a money run', () => {
    expect(parseVoiceExpense('two not five rupees', groups).amountMajor).toBe(205);
  });

  it('reads a bare two-digit spelling as concatenated digits', () => {
    // A pure single-digit run has no tens word, so "two five" is 25 by digits.
    expect(parseVoiceExpense('two five rupees', groups).amountMajor).toBe(25);
    expect(parseVoiceExpense('one two three four rupees', groups).amountMajor).toBe(1234);
  });

  it('keeps the compositional readings unchanged', () => {
    // A tens word or a multiplier means arithmetic, not a digit string.
    expect(parseVoiceExpense('twenty five rupees', groups).amountMajor).toBe(25);
    expect(parseVoiceExpense('two hundred five rupees', groups).amountMajor).toBe(205);
    expect(parseVoiceExpense('five hundred rupees', groups).amountMajor).toBe(500);
    expect(parseVoiceExpense('two rupees', groups).amountMajor).toBe(2);
  });

  // "not" is an ordinary negation; it must never become a number on its own.
  it('never turns a plain negation into an amount', () => {
    // Explicit did-not-pay wording is a rejected payment intent, not an expense.
    expect(parseVoiceExpense('i did not pay five hundred rupees', groups).amountMajor).toBeNull();
    // A standalone "not" beside money does not merge with the amount.
    expect(parseVoiceExpense('not sure, dinner 200 rupees', groups).amountMajor).toBe(200);
    // No number at all stays null.
    expect(parseVoiceExpense('i did not pay for this', groups).amountMajor).toBeNull();
  });
});

// Amounts chained with "plus" (or "+") are one expense whose amount is the sum,
// not several expenses. A comma continues an already-started plus run of bare
// amounts.
describe('spoken addition ("plus")', () => {
  it('sums a plus-joined run into one expense', () => {
    const result = parseVoiceExpenses('twenty rupees plus fifty rupees plus five rupees', groups);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(75);
    expect(result.items[0].currency).toBe('INR');
  });

  it('lets a comma continue the plus run', () => {
    const result = parseVoiceExpenses(
      'twenty rupees plus fifty rupees plus five rupees, sixty, seventy',
      groups,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(205);
  });

  it('sums decimals and minor units to the right total', () => {
    const result = parseVoiceExpenses('ten rupees plus five rupees fifty paise', groups);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(15.5);
    expect(result.items[0].amountMinor).toBe(1550n);
  });

  it('reads the "+" symbol form', () => {
    expect(parseVoiceExpense('20 + 50 + 5', groups).amountMajor).toBe(75);
  });

  it('composes with the digit-sequence reading', () => {
    const result = parseVoiceExpenses('two oh five plus twenty rupees', groups);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(225);
  });

  it('does NOT sum plain comma-separated items with their own descriptions', () => {
    const result = parseVoiceExpenses('5 rupees for snacks, 10 for tea', groups);
    expect(result.items.map((item) => item.amountMajor)).toEqual([5, 10]);
  });

  it('does NOT read the compositional "and" as an addition', () => {
    expect(parseVoiceExpense('five hundred and fifty rupees', groups).amountMajor).toBe(550);
  });
});

describe('detectCreateGroup', () => {
  it('lifts the name and returns the rest', () => {
    expect(detectCreateGroup('create a group named Goa Trip and add 100')).toEqual({
      name: 'Goa Trip',
      rest: 'add 100',
    });
  });

  it('allows with inside the created group name', () => {
    expect(detectCreateGroup('create a group named Friends with Kids and add 100')).toEqual({
      name: 'Friends with Kids',
      rest: 'add 100',
    });
  });

  it('is null when no group is asked for', () => {
    expect(detectCreateGroup('add 100 for lunch')).toBeNull();
  });
});

describe('normalizeDigits', () => {
  it('turns Devanagari, Tamil and Arabic-Indic numerals into ASCII', () => {
    expect(normalizeDigits('५००')).toBe('500');
    expect(normalizeDigits('௫')).toBe('5');
    expect(normalizeDigits('٢٠')).toBe('20');
  });

  it('reads an amount written in native numerals', () => {
    const result = parseVoiceExpenses('५०० rupees for dinner', groups);
    expect(result.items[0]?.amountMajor).toBe(500);
  });
});

describe('parseVoiceExpenses in the app languages', () => {
  it('reads Hindi rupee commands with native numerals and spoken numbers', () => {
    const numeric = parseVoiceExpenses('५०० रुपये चाय', groups);
    expect(numeric.items[0]?.amountMajor).toBe(500);
    expect(numeric.items[0]?.currency).toBe('INR');
    expect(numeric.items[0]?.note).toBe('चाय');

    const spoken = parseVoiceExpenses('पांच सौ रुपये खाना', groups);
    expect(spoken.items[0]?.amountMajor).toBe(500);
    expect(spoken.items[0]?.currency).toBe('INR');
    expect(spoken.items[0]?.note).toBe('खाना');
  });

  it('reads Tamil rupee commands with native numerals and spoken numbers', () => {
    const numeric = parseVoiceExpenses('௫௦௦ ரூபாய் தேநீர்', groups);
    expect(numeric.items[0]?.amountMajor).toBe(500);
    expect(numeric.items[0]?.currency).toBe('INR');
    expect(numeric.items[0]?.note).toBe('தேநீர்');

    const spoken = parseVoiceExpenses('ஐந்து நூறு ரூபாய் சாப்பாடு', groups);
    expect(spoken.items[0]?.amountMajor).toBe(500);
    expect(spoken.items[0]?.currency).toBe('INR');
    expect(spoken.items[0]?.note).toBe('சாப்பாடு');
  });

  it('reads Arabic currency commands with native numerals and spoken numbers', () => {
    const numeric = parseVoiceExpenses('٥٠٠ روبية شاي', groups);
    expect(numeric.items[0]?.amountMajor).toBe(500);
    expect(numeric.items[0]?.currency).toBe('INR');
    expect(numeric.items[0]?.note).toBe('شاي');

    const spoken = parseVoiceExpenses('خمسة مئة درهم قهوة', groups);
    expect(spoken.items[0]?.amountMajor).toBe(500);
    expect(spoken.items[0]?.currency).toBe('AED');
    expect(spoken.items[0]?.note).toBe('قهوة');
  });

  it('recognises a currency word carrying trailing punctuation', () => {
    // "रुपये," / "روبية،" — a comma (ASCII or the Arabic comma) stuck to the
    // currency word must not stop it being recognised: the token is looked up
    // without its punctuation, so the currency still resolves and the word is not
    // left behind in the note. (Singular parse: the multi-expense path treats a
    // comma as a separator, which is a different concern.)
    const hindi = parseVoiceExpense('५०० रुपये, चाय', groups);
    expect(hindi.amountMajor).toBe(500);
    expect(hindi.currency).toBe('INR');
    expect(hindi.note).toBe('चाय');

    const arabic = parseVoiceExpense('٥٠٠ روبية، شاي', groups);
    expect(arabic.amountMajor).toBe(500);
    expect(arabic.currency).toBe('INR');
    expect(arabic.note).toBe('شاي');
  });
});

describe('parseVoiceExpenses — split count and unnamed create-group', () => {
  it('reads a split count without turning it into an extra expense', () => {
    const result = parseVoiceExpenses('split 1000 among 4 people', groups);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(1000);
    expect(result.splitCount).toBe(4);
  });

  it('drops an unnamed create-group instruction but keeps the expense', () => {
    const result = parseVoiceExpenses('create a group and add 500 for dinner', groups);
    expect(result.group).toBeNull();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(500);
  });
});
