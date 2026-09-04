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
    title: t.legal.privacyTitle,
    alternates: { canonical: absoluteUrl(`/${locale}/privacy`) },
  };
}

const sections: LegalSection[] = [
  {
    heading: 'What we collect',
    body: [
      'An account needs an email address, and a display name if you set one. Signing in with Google or Apple gives us the email address and name that provider returns; we ask for nothing else from them.',
      'The ledger itself — groups, the people in them, expenses, amounts, currencies, splits, comments, settlements and any notes you write — is stored so it can be shared with the people you share a group with, and so it survives losing your phone.',
      'Optional things you choose to add: receipt images and expense photos, a location on an expense, and a voice recording that is transcribed on your device and then discarded.',
      'Technical data we cannot avoid: the device model and app version for crash reports, and a push notification token if you turn notifications on.',
    ],
  },
  {
    heading: 'What we do not do',
    body: [
      'We do not sell your data, and we do not share it with advertisers or data brokers. There are no third-party advertising or tracking pixels in the app.',
      'We do not read your SMS, contacts, camera roll or microphone in the background. Where the app offers to read a payment SMS or scan a receipt, it happens on your device, when you ask for it, and only for the item in front of you.',
      'We never take custody of your money. Waves works out who owes whom and hands the amount to your payment app; the payment itself happens between you and that provider.',
    ],
  },
  {
    heading: 'Where it is stored',
    body: [
      'The copy on your phone is encrypted at rest. The key lives in the device keystore, never leaves it and is destroyed when you sign out, which makes the local copy unreadable.',
      'The server copy lives in a managed Postgres database with row-level security, so a request can only ever reach rows belonging to a group you are in.',
      'Receipt and expense photos can be kept on the device only, backed up to your own Google Drive, Dropbox or OneDrive, or — for a shared group photo — stored in our object storage. You choose which, per photo.',
    ],
  },
  {
    heading: 'Who processes it for us',
    body: [
      'We use a small number of infrastructure providers, each for one job: managed database, authentication and file storage; object storage for shared images; email delivery for invitations and receipts of settlement; Apple and Google push services for notifications; and an error-reporting service for crashes. Product analytics, if enabled, is opt-in and can be turned off in the app at any time.',
      'These providers process data on our instructions and are not permitted to use it for their own purposes.',
    ],
  },
  {
    heading: 'How long we keep it',
    body: [
      'Ledger data is kept while your account exists, because the other people in a group depend on it being there. Deleting your account removes your rows and your sign-in identity; expenses you created inside a shared group are anonymised rather than deleted, so the group balance does not silently change for everyone else.',
      'Crash reports are kept for 90 days. Email delivery logs are kept for as long as the provider retains them, and no longer than a year.',
    ],
  },
  {
    heading: 'Your choices',
    body: [
      'You can export your data at any time from inside the app, delete your account from inside the app, turn notification categories on and off individually, and unsubscribe from any email with one click.',
      'If you are in a jurisdiction with a statutory right to access, correction, portability or erasure, those requests are honoured — write to us and we will action them.',
    ],
  },
  {
    heading: 'Children',
    body: [
      'Waves is not directed at children under 13, and we do not knowingly collect their data. If you believe a child has created an account, write to us and we will remove it.',
    ],
  },
  {
    heading: 'Changes',
    body: [
      'If this policy changes materially we will say so in the app before the change takes effect, not only by editing this page.',
    ],
  },
];

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = await getDictionary(locale);

  return (
    <LegalPage
      locale={locale}
      t={t.legal}
      title={t.legal.privacyTitle}
      updated={UPDATED}
      intro={`${site.name} is an expense ledger. It only works if it holds a record of what people spent, so this page says plainly what is held, where it sits, who else touches it and how to get rid of it.`}
      sections={sections}
    />
  );
}
