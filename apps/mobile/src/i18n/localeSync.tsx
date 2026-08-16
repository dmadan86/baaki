/**
 * Telling the server which language to write to somebody in.
 *
 * The language picker is a device setting — AsyncStorage, instant, offline.
 * Notifications are not: they are written by Postgres and rendered by an edge
 * function, neither of which can see a phone's storage. What they read is
 * `profiles.locale`, which until now was set once from the sign-up metadata and
 * never touched again. So somebody could put the entire app into Tamil and go
 * on receiving push in English forever, with nothing on any screen to explain
 * it.
 *
 * This is the one line between the two. It lives in its own component rather
 * than inside `LanguageProvider` because that provider sits above the auth
 * tree — deliberately, so the sign-in screen has strings — and cannot reach a
 * session from up there.
 *
 * Failure is silent on purpose. A locale that did not reach the server means
 * the next notification arrives in the previous language; holding a toast in
 * front of somebody who has just changed a setting, over a row they cannot fix
 * and did not ask about, is worse than the wrong language on one notification.
 * The effect runs again on the next change and on every fresh session.
 */

import { useEffect, useRef } from 'react';

import { useAuth } from '@/lib/auth';
import { useLanguage } from '@/i18n/language';

export function LocaleSync() {
  const { locale, loading } = useLanguage();
  const { session, profile, updateProfile } = useAuth();

  // The locale already attempted for this session. Guards against an unbounded
  // series of writes when the server normalises the value (so the equality
  // check never holds) or the write fails (and swallows the rejection).
  const attempted = useRef<string | null>(null);

  // A fresh session retries once.
  useEffect(() => {
    attempted.current = null;
  }, [session]);

  useEffect(() => {
    // `loading` matters: the stored choice arrives a tick after mount, and
    // writing the phone's locale in that tick would overwrite a real choice
    // with the default every single launch.
    if (loading || !session || !profile) return;
    if (profile.locale === locale) return;
    if (attempted.current === locale) return;
    attempted.current = locale;
    void updateProfile({ locale }).catch(() => undefined);
  }, [loading, session, profile, locale, updateProfile]);

  return null;
}
