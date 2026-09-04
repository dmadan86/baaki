import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { LegalPage, type LegalSection } from '@/components/legal-page';
import { isLocale, locales } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { absoluteUrl, site } from '@/lib/site';

const UPDATED = '3 September 2026';

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getDictionary(locale);
  return {
    title: t.legal.termsTitle,
    alternates: { canonical: absoluteUrl(`/${locale}/terms`) },
  };
}

const sections: LegalSection[] = [
  {
    heading: 'What Waves is',
    body: [
      'Waves is a record-keeping tool. It tracks what a group of people spent and works out who owes whom. It is not a bank, a payment institution, a lender or a financial adviser, and it does not hold, transfer or take custody of money at any point.',
      'When you settle up, Waves passes an amount and a recipient to a payment app you already use. What happens after that is between you and that provider.',
    ],
  },
  {
    heading: 'Your account',
    body: [
      'You need an account to keep a ledger across devices. Keep your sign-in secure; anyone who can reach your email can reach your account.',
      'You are responsible for what you put into the app, including that you have the right to add the people and the information you add.',
    ],
  },
  {
    heading: 'The ledger is a record, not a judgment',
    body: [
      'Balances are arithmetic over what the people in a group entered. If somebody enters the wrong number, the balance is wrong. Waves does not verify, adjudicate or enforce a debt between you and anyone else, and a balance in the app is not a legal instrument.',
      'Currency conversion uses whichever rate you chose or a published reference rate. It is an estimate for splitting a bill, not a quote.',
    ],
  },
  {
    heading: 'Acceptable use',
    body: [
      'Do not use Waves to harass anyone, to store content you have no right to store, to break the law in your jurisdiction, or to attack the service — automated scraping, probing, or attempting to reach data belonging to a group you are not in.',
      'We may suspend an account that is doing any of the above, and will say why where we are permitted to.',
    ],
  },
  {
    heading: 'Free and paid',
    body: [
      'The core ledger — groups, expenses, splits, currencies, offline use and settling up — is free and unlimited. Paid features exist for the parts with a per-use cost behind them, and are billed through the app store you bought them from.',
      'Refunds follow the rules of that app store. Cancelling stops future charges; it does not delete your ledger.',
    ],
  },
  {
    heading: 'Availability',
    body: [
      'Waves is designed to keep working with no network, so an outage on our side does not stop you adding an expense. It can still stop syncing, invitations and notifications. We do not promise uninterrupted service, and we do not promise that a feature available today will be available forever — though we will give notice before removing one that people depend on.',
    ],
  },
  {
    heading: 'Liability',
    body: [
      'To the extent the law allows, Waves is provided as-is, and we are not liable for indirect or consequential loss, or for a payment you made or failed to make on the strength of a balance in the app. Nothing here limits liability that cannot lawfully be limited.',
    ],
  },
  {
    heading: 'Ending it',
    body: [
      'You can delete your account from inside the app at any time. We may close an account that breaches these terms. Either way, the parts of these terms that should survive — liability, governing law — do.',
    ],
  },
];

export default async function TermsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = await getDictionary(locale);

  return (
    <LegalPage
      locale={locale}
      t={t.legal}
      title={t.legal.termsTitle}
      updated={UPDATED}
      intro={`These are the terms you agree to by using ${site.name}. They are written to be read, not to be survived.`}
      sections={sections}
    />
  );
}
