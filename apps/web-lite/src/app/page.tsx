/**
 * There is no web app. This page exists because somebody will type the domain
 * in, and a blank 404 tells them nothing about what they were sent.
 */

import { headers } from 'next/headers';

import { pickLanguage, stringsFor } from '@/i18n';

export default async function Home() {
  const t = stringsFor(pickLanguage((await headers()).get('accept-language')));

  return (
    <main>
      <div className="card">
        <h1>{t.home.title}</h1>
        <p>{t.home.description}</p>
        <p className="faint">{t.home.elsewhere}</p>
      </div>
    </main>
  );
}
