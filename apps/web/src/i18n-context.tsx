'use client';

/**
 * Handing the server's answer down to the client pages.
 *
 * The language is decided once, on the server, from `Accept-Language` — see
 * `layout.tsx`. Three of the four pages are client components and cannot read
 * a request header, so the resolved language and locale come down through this
 * provider rather than being guessed a second time from `navigator.language`.
 *
 * Guessing twice is the bug this avoids: the server would render Arabic and the
 * client would re-render English on a phone whose browser UI language differs
 * from what it sends, and the page would visibly change its mind.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { stringsFor, type Language, type WebStrings } from '@/i18n';

interface Value {
  language: Language;
  locale: string;
  t: WebStrings;
}

const StringsContext = createContext<Value | null>(null);

export function StringsProvider({
  language,
  locale,
  children,
}: {
  language: Language;
  locale: string;
  children: ReactNode;
}) {
  const value = useMemo<Value>(
    () => ({ language, locale, t: stringsFor(language) }),
    [language, locale],
  );
  return <StringsContext.Provider value={value}>{children}</StringsContext.Provider>;
}

export function useStrings(): Value {
  const value = useContext(StringsContext);
  if (!value) throw new Error('useStrings must be used inside StringsProvider');
  return value;
}
