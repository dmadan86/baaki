/**
 * What a bank alert says, in the languages banks say it in.
 *
 * Split out of `parse.ts` because it is data, not logic: long ordered word
 * lists that grow every time somebody tries the feature in a new country, and
 * that nobody should have to read past to understand how the parser works.
 *
 * Three rules govern everything here.
 *
 * **Terms are written unaccented.** `parse.ts` folds the message to unaccented
 * Latin *without changing its length*, so every index still points where it
 * did, and every term below is written the way that fold leaves it: `débité`
 * becomes `debite`, `ağustos` becomes `agustos`, `số dư` becomes `so du`.
 * Writing the accented form here would produce a list that looks like French
 * support and matches nothing.
 *
 * **Latin and non-Latin are kept apart.** JavaScript's `\b` is defined against
 * `[A-Za-z0-9_]`, so there is no word boundary between a space and an Arabic,
 * Thai or Devanagari letter — `/\bمرفوض\b/` matches nothing, ever, and would
 * sit in the file looking like Arabic support while providing none. Latin terms
 * get `\b`; everything else is matched as a plain substring, which is correct
 * for scripts that do not separate words the way Latin does.
 *
 * **A word only earns its place if a false accept is unlikely.** This parser's
 * worst outcome is proposing an expense nobody made, so a verb that is also an
 * ordinary word in another language the parser might see is left out rather
 * than guessed at.
 */

/** Latin terms joined into one alternation, word-bounded. */
const latin = (terms: readonly string[]): string => `\\b(?:${terms.join('|')})\\b`;

/** Non-Latin terms joined into one alternation, unbounded — see the note above. */
const script = (terms: readonly string[]): string => `(?:${terms.join('|')})`;

const either = (latinTerms: readonly string[], scriptTerms: readonly string[]): string =>
  `(?:${latin(latinTerms)}|${script(scriptTerms)})`;

/* ------------------------------------------------------------------ *
 * Direction
 * ------------------------------------------------------------------ */

/**
 * Money left the account.
 *
 * `transaction of` and `used for a transaction of` are here because that is how
 * every card issuer writes a purchase; bare `transaction` is not, because
 * "transaction declined" and "your transaction reference" are both common and
 * neither is a debit.
 */
const DEBIT_LATIN = [
  // English
  'used for a transaction of',
  'transaction of',
  'txn of',
  'debited',
  'debit',
  'spent',
  'paid',
  'purchased',
  'purchase',
  'withdrawn',
  'withdrawal',
  'sent',
  'deducted',
  'charged',
  // Spanish
  'cargo',
  'cargado',
  'cargada',
  'compra',
  'retiro',
  'debitado',
  'debitada',
  'pagado',
  'gastado',
  // Portuguese
  'saque',
  'pago',
  'cobrado',
  // French
  'debite',
  'debitee',
  'retrait',
  'preleve',
  'prelevement',
  'achat',
  'paye',
  // German
  'belastet',
  'abbuchung',
  'abgebucht',
  'lastschrift',
  'bezahlt',
  'abgehoben',
  // Italian / Dutch
  'addebitato',
  'addebito',
  'afgeschreven',
  'betaald',
  'opname',
  // Indonesian / Malay
  'didebet',
  'didebit',
  'didebitkan',
  'dipotong',
  'belanja',
  'pembelian',
  // Turkish
  'harcama',
  'cekildi',
  'odendi',
  // Danish, Swedish, Norwegian — the markets the `kr` marker belongs to
  'kortkop',
  'kortkjop',
  'debiteret',
  'debiterats',
  'dragits',
  'trukket',
  'uttag',
  'hevet',
  'betalt',
  // Vietnamese, as the fold leaves it
  'ghi no',
  'thanh toan',
  'tru tien',
  // Russian, transliterated
  'spisano',
  'oplata',
] as const;

const DEBIT_SCRIPT = [
  // Hindi
  'डेबिट',
  'निकाले',
  'भुगतान',
  'खर्च',
  // Tamil
  'பற்று',
  'செலவு',
  'செலுத்த',
  // Arabic — خصم deducted, سحب withdrawn, شراء purchase, دفع paid
  'خصم',
  'مدين',
  'سحب',
  'شراء',
  'دفع',
  // Thai
  'ถูกหัก',
  'หักเงิน',
  'ชำระเงิน',
  'ใช้จ่าย',
  // Russian
  'списано',
  'оплата',
  'покупка',
] as const;

/** Money arrived. Deliberately includes `refunded`, which the old list missed. */
const CREDIT_LATIN = [
  // English
  'credited',
  'credit',
  'received',
  'refunded',
  'refund',
  'reversed',
  'reversal',
  'cashback',
  'deposited',
  // Spanish / Portuguese
  'abonado',
  'abono',
  'acreditado',
  'creditado',
  'reembolsado',
  'reembolso',
  'deposito',
  'recibido',
  'devolucion',
  'estorno',
  // French
  'credite',
  'creditee',
  'rembourse',
  'remboursement',
  // German / Dutch / Italian
  'gutgeschrieben',
  'gutschrift',
  'erstattet',
  'erstattung',
  'bijgeschreven',
  'ontvangen',
  'accreditato',
  'accredito',
  'rimborso',
  // Indonesian / Malay / Turkish
  'dikreditkan',
  'dikredit',
  'diterima',
  'iade',
  'yatirildi',
  // Danish, Swedish, Norwegian
  'insatt',
  'indsat',
  'innsatt',
  'tilbakebetalt',
  'aterbetalning',
  // Vietnamese / Russian, as the fold leaves them
  'ghi co',
  'hoan tien',
  'zachislenie',
] as const;

const CREDIT_SCRIPT = [
  'क्रेडिट',
  'जमा',
  'वापसी',
  'வரவு',
  'திரும்ப',
  'إيداع',
  'دائن',
  'استرداد',
  'أضيف',
  'เข้าบัญชี',
  'คืนเงิน',
  'зачислено',
  'возврат',
] as const;

/** The alternations on their own, so larger patterns can embed them. */
export const DEBIT_SOURCE = either(DEBIT_LATIN, DEBIT_SCRIPT);
export const CREDIT_SOURCE = either(CREDIT_LATIN, CREDIT_SCRIPT);

export const DEBIT_WORDS = new RegExp(DEBIT_SOURCE, 'giu');
export const CREDIT_WORDS = new RegExp(CREDIT_SOURCE, 'giu');

/**
 * "Credit Card" is not a credit, and reading it as one is the single failure in
 * this parser that writes a wrong ledger entry rather than losing a right one.
 * These phrases are blanked — replaced by spaces of the same length, so every
 * other index into the message still points where it did — before direction is
 * decided. `debit card` goes with it for the mirror-image reason.
 */
export const CARD_PHRASES = new RegExp(
  [
    '\\b(?:credit|debit)\\s*/?\\s*(?:credit|debit)?\\s*cards?\\b',
    '\\btarjeta\\s+de\\s+(?:credito|debito)\\b',
    '\\bcartao\\s+de\\s+(?:credito|debito)\\b',
    '\\bcarte\\s+de\\s+(?:credit|debit)\\b',
    '\\b(?:kredit|debit)\\s*-?\\s*karte\\b',
    '\\bkartu\\s+(?:kredit|debit)\\b',
    '\\bkredi\\s+kart\\w*\\b',
    '\\bcarta\\s+di\\s+credito\\b',
    '\\bthe\\s+(?:tin\\s+dung|ghi\\s+no)\\b',
    'بطاقة\\s+(?:الائتمان|ائتمانية|الخصم)',
    'क्रेडिट\\s*कार्ड',
    'डेबिट\\s*कार्ड',
    'கிரெடிட்\\s*கார்டு',
    'டெபிட்\\s*கார்டு',
    'บัตรเครดิต',
    'บัตรเดบิต',
  ].join('|'),
  'giu',
);

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

/**
 * Messages shaped like a transaction that are not one.
 *
 * A one-time password is the dangerous member of this set: right sender, right
 * amount, right merchant, and a person tapping through confirms a purchase they
 * were in the middle of *not* making. Every language added to the debit list
 * above has to be added here too, or internationalising the parser means
 * internationalising its worst false positive.
 */
export const NOT_A_TRANSACTION = new RegExp(
  [
    latin([
      // English
      'OTP',
      'one[- ]time\\s*password',
      'one[- ]time\\s*code',
      'verification\\s+code',
      'security\\s+code',
      'will\\s+be\\s+debited',
      'will\\s+be\\s+charged',
      'will\\s+be\\s+deducted',
      '(?:has|have)\\s+requested',
      'request(?:ed)?\\s+(?:for|to)',
      'is\\s+due',
      'due\\s+on',
      'due\\s+by',
      'payment\\s+due',
      'minimum\\s+due',
      'reminder',
      'failed',
      'declined',
      'unsuccessful',
      'statement',
      'e-?mandate',
      'auto[- ]?pay\\s+scheduled',
      'scheduled\\s+for',
      // Spanish
      'codigo\\s+(?:de\\s+)?(?:verificacion|seguridad)',
      'clave\\s+temporal',
      'rechazad[ao]',
      'fallid[ao]',
      'sera\\s+(?:cargado|debitado)',
      'se\\s+debitara',
      'vence\\s+el',
      'fecha\\s+de\\s+vencimiento',
      // Portuguese
      'codigo\\s+de\\s+verificacao',
      'recusad[ao]',
      'negad[ao]',
      'sera\\s+(?:debitado|cobrado)',
      'vencimento',
      // French
      'code\\s+de\\s+(?:verification|securite)',
      'refusees?',
      'refusee',
      'echec',
      'sera\\s+(?:debite|preleve)',
      'echeance',
      // German
      'einmalkennwort',
      'einmalpasswort',
      'bestatigungscode',
      'abgelehnt',
      'fehlgeschlagen',
      // German puts the amount between the auxiliary and the participle —
      // "wird mit EUR 49,90 belastet" — so the two cannot be required to be
      // adjacent the way English's "will be debited" can.
      'wird\\s+[^.]{0,48}?\\s*(?:belastet|abgebucht)',
      'fallig\\s+am',
      // Indonesian / Malay
      'kode\\s+otp',
      'kod\\s+otp',
      'kode\\s+verifikasi',
      'ditolak',
      'gagal',
      'jatuh\\s+tempo',
      'akan\\s+didebet',
      // Turkish
      'dogrulama\\s+kodu',
      'tek\\s+kullanimlik',
      'reddedildi',
      'basarisiz',
      'son\\s+odeme',
      // Vietnamese / Russian, as the fold leaves them
      'ma\\s+otp',
      'ma\\s+xac\\s+thuc',
      'that\\s+bai',
      'tu\\s+choi',
      'den\\s+han',
      'kod\\s+podtverzhdeniya',
    ]),
    script([
      // Hindi
      'ओटीपी',
      'सत्यापन\\s*कोड',
      'अस्वीकृत',
      'विफल',
      'देय\\s*तिथि',
      'किया\\s*जाएगा',
      // Tamil
      'ஒருமுறை\\s*கடவுச்சொல்',
      'நிராகரிக்கப்பட்டது',
      'தோல்வி',
      // Arabic
      'رمز\\s*التحقق',
      'كلمة\\s*المرور\\s*لمرة',
      'مرفوض',
      'فشل',
      'مستحق',
      'سيتم\\s*خصم',
      'تاريخ\\s*الاستحقاق',
      // Thai
      'รหัสยืนยัน',
      'ปฏิเสธ',
      'ไม่สำเร็จ',
      'ครบกำหนด',
      // Russian
      'код\\s*подтверждения',
      'отклонен',
      'отказано',
    ]),
  ].join('|'),
  'iu',
);

/**
 * Balance words. A running balance is a trailer on real debit alerts, so these
 * only disqualify a message that says nothing about money moving — and they
 * separately mark an amount as "this number is a balance, not a transaction",
 * which is how the parser stops picking the wrong one of two amounts.
 */
export const BALANCE_WORDS = new RegExp(
  [
    latin([
      'avl\\s*bal\\w*',
      'avbl\\s*bal\\w*',
      'avail(?:able)?\\s*bal(?:ance)?',
      'balance',
      'bal',
      'saldo',
      'solde',
      'kontostand',
      'guthaben',
      'bakiye',
      'baki',
      'so\\s*du',
      'ostatok',
      'limit',
    ]),
    script(['الرصيد', 'शेष', 'बैलेंस', 'இருப்பு', 'ยอดคงเหลือ', 'остаток', 'баланс']),
  ].join('|'),
  'giu',
);

/** The subset that, alone, makes a message a balance report rather than a debit. */
export const BALANCE_ONLY = new RegExp(
  [
    latin([
      'balance\\s+is',
      'avl\\s*bal\\w*',
      'avbl\\s*bal\\w*',
      'available\\s+balance\\s+is',
      'saldo\\s+(?:es|e|disponivel|disponible|adalah)',
      'solde\\s+disponible',
      'ihr\\s+kontostand',
      'so\\s*du\\s*kha\\s*dung',
    ]),
    script(['الرصيد\\s*المتاح', 'शेष\\s*राशि', 'ยอดคงเหลือ']),
  ].join('|'),
  'iu',
);

/* ------------------------------------------------------------------ *
 * Fields
 * ------------------------------------------------------------------ */

/**
 * The masked tail of an account or card.
 *
 * Written out rather than built with `latin()` for two reasons, both of which
 * were bugs the first time round: `xx+` must not carry a *trailing* word
 * boundary, because `xx1234` has none between the x and the 1; and the Arabic,
 * Thai and Devanagari words must not carry a *leading* one, because `البطاقة`
 * begins with letters `\b` does not recognise, so the pattern would have
 * matched nothing in exactly the scripts it was added for.
 */
export const ACCOUNT_TAIL = new RegExp(
  '(?:' +
    '\\b(?:a\\/c|acct?|account|akaun|card|kart\\w*|conta|cuenta|compte|konto|rekening|hesab\\w*|xx+)' +
    '|\\*+' +
    '|บัญชี|حساب|بطاقة|खाता|கணக்கு' +
    ')\\s*(?:no\\.?\\s*|nr\\.?\\s*|num\\.?\\s*)?[xX*·.]*(\\d{3,6})\\b',
  'iu',
);

export const REFERENCE = new RegExp(
  '(?:' +
    latin([
      'ref\\s*no',
      'refno',
      'ref(?:erence)?',
      'txn(?:\\s*id)?',
      'transaction(?:\\s*id)?',
      'trn',
      'rrn',
      'utr',
      'auth(?:\\s*code)?',
      'referencia',
      'referenz',
      'belegnr',
      'referensi',
      'ma\\s*giao\\s*dich',
    ]) +
    '|' +
    script(['مرجع', 'رقم\\s*العملية', 'संदर्भ', 'குறிப்பு', 'หมายเลขอ้างอิง']) +
    ')\\s*(?:no\\.?|nr\\.?|id)?[:\\s]\\s*([A-Za-z0-9]{6,})',
  'iu',
);

/**
 * The words that introduce whoever was paid.
 *
 * Short function words from other languages are a real hazard here — Spanish
 * `a`, French `à` and Portuguese `no` are all common English fragments too, and
 * each one would mint a merchant out of the middle of an English sentence. They
 * are left out on purpose; what survives is the set that is either unambiguous
 * or long enough not to collide.
 */
export const MERCHANT_PREPOSITIONS = [
  latin([
    'to',
    'at',
    'towards?',
    'in\\s+fav(?:ou)?r\\s+of',
    'en', // es
    'em',
    'para', // pt
    'chez', // fr
    'bei', // de
    'presso', // it
    'bij', // nl
    'di',
    'ke',
    'kepada',
    'pada', // id / ms
    'tai', // vi
    'hos', // da / sv / nb
  ]),
  script(['ที่', 'لدى', 'إلى', 'في', 'को', 'இல்']),
].join('|');

/**
 * Tokens that are the bank talking, not the shop's name. A captured phrase is
 * cut at the first of these, which is what turns "SWIGGY Refno 526012345678"
 * into "SWIGGY".
 */
export const MERCHANT_NOISE: ReadonlySet<string> = new Set([
  // Every preposition is its own terminator: "TOKOPEDIA pada 12/09/2026" is a
  // shop followed by a date, not a four-word shop.
  'on',
  'at',
  'to',
  'by',
  'from',
  'in',
  'en',
  'em',
  'para',
  'chez',
  'bei',
  'presso',
  'bij',
  'di',
  'ke',
  'kepada',
  'pada',
  'tai',
  'hos',
  'khoan',
  'ngay',
  'towards',
  'toward',
  'is',
  'was',
  'has',
  // The bank's closing instructions. Every Indian bank ends a debit alert with
  // one — "To dispute, call 1800…", "To report fraud, SMS BLOCK to…" — and "to"
  // is a merchant preposition, so without these the sentence meant to protect
  // somebody becomes the name of the shop they paid. Axis produced exactly
  // that: a ₹400 payment filed under "dispute", at full confidence, which is
  // worse than no name at all because nothing about it looks wrong.
  'dispute',
  'report',
  'block',
  'call',
  'sms',
  'query',
  'queries',
  'complaint',
  'complain',
  'unauthorised',
  'unauthorized',
  // "with a card ending…" in the languages that say it after the shop's name.
  'con',
  'com',
  'mit',
  'met',
  'avec',
  'tarjeta',
  'cartao',
  'carte',
  'karte',
  'kart',
  'kartu',
  'no',
  'na',
  'بتاريخ',
  'ref',
  'refno',
  'reference',
  'referencia',
  'referenz',
  'upi',
  'imps',
  'neft',
  'rtgs',
  'txn',
  'trn',
  'rrn',
  'utr',
  'id',
  'info',
  'avl',
  'avbl',
  'bal',
  'balance',
  'saldo',
  'solde',
  'not',
  'call',
  'dt',
  'date',
  'using',
  'via',
  'card',
  'a/c',
  'ac',
  'acct',
  'account',
  'conta',
  'cuenta',
  'compte',
  'konto',
  'rekening',
  'am',
  'um',
  'auf',
  'op',
]);

/** Tokens skipped when they *start* a capture: "to your HDFC Card" is not "your". */
export const MERCHANT_DETERMINERS: ReadonlySet<string> = new Set([
  'your',
  'the',
  'my',
  'a',
  'an',
  'su',
  'sua',
  'seu',
  'votre',
  'ihr',
  'ihre',
  'uw',
  'anda',
  'vpa',
  'upi',
]);

/**
 * A capture that is one of these is not a merchant, whatever the grammar says.
 * `VPA` and `A` are the two the old parser actually produced, and a row reading
 * "A" is worse than a row reading nothing: it looks parsed.
 */
export const MERCHANT_STOP_WORDS: ReadonlySet<string> = new Set([
  'vpa',
  'upi',
  'a',
  'ac',
  'a/c',
  'acct',
  'account',
  'card',
  'ref',
  'refno',
  'reference',
  'txn',
  'trn',
  'transaction',
  'transaksi',
  'payment',
  'purchase',
  'merchant',
  'bank',
  'pos',
  'atm',
  'na',
  'n/a',
  'nil',
  'null',
  'cuenta',
  'conta',
  'compte',
  'konto',
  'rekening',
  'saldo',
  'solde',
  'balance',
  'bal',
  // Same reasoning as the noise list above: whatever the grammar says, the
  // sentence telling somebody how to complain is not a payee.
  'dispute',
  'report',
  'block',
  'call',
  'sms',
  'helpline',
  'customer care',
]);

/* ------------------------------------------------------------------ *
 * Months
 * ------------------------------------------------------------------ */

/**
 * Month names, folded to unaccented lowercase, across the languages the app
 * ships in and the ones its markets bank in. Looked up longest key first, which
 * is how French `juin` (6) and `juillet` (7) stay apart when both start `jui`.
 */
export const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  // English
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  // Spanish
  ene: 1,
  abr: 4,
  ago: 8,
  dic: 12,
  // Portuguese
  fev: 2,
  mai: 5,
  set: 9,
  out: 10,
  dez: 12,
  // French — four-letter keys so juin and juillet do not collide
  janv: 1,
  fevr: 2,
  mars: 3,
  avr: 4,
  juin: 6,
  juil: 7,
  aout: 8,
  sept: 9,
  // German
  mrz: 3,
  okt: 10,
  // Italian
  gen: 1,
  mag: 5,
  giu: 6,
  lug: 7,
  ott: 10,
  // Dutch
  mrt: 3,
  maa: 3,
  mei: 5,
  // Indonesian / Malay
  agu: 8,
  ags: 8,
  des: 12,
  // Turkish
  oca: 1,
  sub: 2,
  nis: 4,
  haz: 6,
  tem: 7,
  eyl: 9,
  eki: 10,
  kas: 11,
  ara: 12,
});

/* ------------------------------------------------------------------ *
 * Kinds
 * ------------------------------------------------------------------ */

/**
 * Money that moved but was not spent or earned.
 *
 * A splitting app cares about one thing: what a person paid somebody else for
 * something. A great deal of what a bank sends is money moving without that
 * being true — a card bill settled out of the same account that made the
 * purchases, a wallet loaded, a fund bought, cash taken out of a machine. Every
 * one of those is a debit, and reading them as expenses is how an imported
 * ledger ends up double-counting a month: once when the card was used, and
 * again when the card was paid.
 *
 * These lists sort them out. Each is deliberately narrow — an "other" that
 * swallowed a real expense would lose it silently, which is the failure this
 * parser is built to avoid — and each keeps the file's three rules: unaccented,
 * Latin and non-Latin separated, and no term that is an ordinary word somewhere
 * the parser might be pointed.
 *
 * None of them carries the `g` flag. Every one is used with `test` over a whole
 * inbox, and a global regex remembers where it stopped: the second call on an
 * identical message comes back false, and half of somebody's credit card bills
 * quietly become expenses.
 */

/**
 * A card bill being settled, not a purchase being made.
 *
 * `payment` alone is nowhere near specific enough — half of all bank messages
 * contain it — so every term here names the card or the statement as well.
 */
export const CARD_BILL = new RegExp(
  [
    latin([
      'credit\\s*card\\s*(?:bill\\s*)?payment',
      'card\\s*payment\\s+(?:settled|received|successful)',
      'payment\\s+(?:received|credited)\\s+(?:towards|to|for)\\s+(?:your\\s+)?(?:credit\\s+)?card',
      'towards\\s+(?:your\\s+)?(?:credit\\s+)?card\\s+(?:bill|dues|outstanding)',
      'statement\\s+(?:dues?|amount)\\s+(?:paid|settled)',
      'card\\s+bill\\s+(?:paid|settled)',
      'e-?mandate\\s+(?:executed|processed)',
      'autopay\\s+(?:executed|processed|successful)',
      'pago\\s+de\\s+tarjeta',
      'paiement\\s+de\\s+carte',
      'kartenzahlung\\s+ausgeglichen',
    ]),
    script(['بطاقة\\s*الائتمان\\s*سداد', 'क्रेडिट\\s*कार्ड\\s*भुगतान', 'ชำระบัตรเครดิต']),
  ].join('|'),
  'iu',
);

/**
 * A wallet, prepaid card or transit pass being loaded.
 *
 * Bare `recharge` is left out on purpose: a mobile recharge is a real expense,
 * and in Indian English "recharge" means that far more often than it means a
 * wallet top-up. Every term here names the wallet.
 */
export const WALLET_TOPUP = new RegExp(
  latin([
    'wallet\\s+(?:recharge|top[\\s-]?up|load(?:ed)?)',
    '(?:recharge|top[\\s-]?up|loaded|added)\\s+(?:to\\s+)?(?:your\\s+)?wallet',
    'added\\s+to\\s+(?:your\\s+)?(?:paytm|phonepe|amazon\\s*pay|gpay)\\s*(?:balance|wallet)',
    'prepaid\\s+(?:card\\s+)?(?:reload|top[\\s-]?up)',
    'recarga\\s+de\\s+(?:billetera|monedero)',
    'rechargement\\s+du\\s+portefeuille',
  ]),
  'iu',
);

/**
 * Money going into an investment: a fund, a deposit, a pension.
 *
 * Bought units are savings, not spending — and in a splitting app they are
 * never somebody else's share of anything.
 */
export const INVESTMENT = new RegExp(
  [
    latin([
      'sip\\s+(?:payment|instal+ment|debit)',
      'systematic\\s+investment',
      'mutual\\s+fund',
      'units?\\s+(?:allot+ed|purchased)',
      'folio\\s*(?:no|number)',
      'recurring\\s+deposit',
      'fixed\\s+deposit',
      'nps\\s+contribution',
      'ppf\\s+(?:contribution|deposit)',
      'towards\\s+(?:your\\s+)?(?:rd|fd|sip)',
    ]),
    script(['म्यूचुअल\\s*फंड', 'กองทุนรวม']),
  ].join('|'),
  'iu',
);

/**
 * A transfer between the person's own accounts. Not a payment to anybody.
 */
export const SELF_TRANSFER = new RegExp(
  [
    latin([
      '(?:to|between)\\s+your\\s+own\\s+accounts?',
      'own\\s+account\\s+transfer',
      'self\\s*-?\\s*transfer',
      'transfer(?:red)?\\s+to\\s+self',
      'entre\\s+(?:tus|sus)\\s+cuentas',
      'virement\\s+interne',
    ]),
    script(['अपने\\s*खाते\\s*में']),
  ].join('|'),
  'iu',
);

/**
 * Cash out of a machine or over a counter.
 *
 * The money has not been spent yet; it has changed shape. FinArt calls the same
 * idea "cash in hand", and counting it as an expense double-counts every cash
 * purchase a person later enters by hand.
 */
export const CASH_WITHDRAWAL = new RegExp(
  [
    latin([
      'cash\\s+(?:withdraw\\w*|wdl)',
      'withdraw\\w*\\s+(?:from|at)\\s+(?:atm|a\\s*t\\s*m)',
      'atm\\s+(?:cash\\s+)?withdraw\\w*',
      'atm\\s+wdl',
      'retiro\\s+(?:en\\s+)?cajero',
      'retrait\\s+(?:au\\s+)?distributeur',
      'bargeldabhebung',
    ]),
    script(['नकद\\s*निकासी', 'ถอนเงินสด', 'سحب\\s*نقدي']),
  ].join('|'),
  'iu',
);

/**
 * A payment coming back. Real, and worth seeing — but it is the reversal of an
 * expense rather than income, so it belongs with neither.
 */
export const REFUND = new RegExp(
  [
    latin([
      'refund(?:ed)?',
      'reversed',
      'reversal',
      'charge\\s*back',
      'reembolso',
      'remboursement',
      'erstattung',
      'rimborso',
      'iade\\s+edildi',
      'hoan\\s*tien',
    ]),
    script(['वापसी', 'استرداد', 'คืนเงิน', 'возврат']),
  ].join('|'),
  'iu',
);

/* ------------------------------------------------------------------ *
 * UPI reference strings
 * ------------------------------------------------------------------ */

/**
 * The segment codes an Indian UPI reference carries, which are never the payee.
 *
 * A UPI alert names who was paid inside a slash-separated reference rather than
 * in the sentence: `UPI/P2M/526012345678/ZOMATO LTD`. `P2A` is person-to-account,
 * `P2M` person-to-merchant, `P2P` person-to-person; `CR`/`DR` say which way the
 * money went. All of them sit exactly where a name could, so a reader that took
 * the first lettered segment would file a payment under "P2M".
 */
export const UPI_SEGMENT_CODES: ReadonlySet<string> = new Set([
  'upi',
  'p2a',
  'p2m',
  'p2p',
  'cr',
  'dr',
  'ft',
  'imps',
  'neft',
  'rtgs',
  'ach',
  'mandate',
  'collect',
  'pay',
  'payment',
  'refund',
  'reversal',
]);
