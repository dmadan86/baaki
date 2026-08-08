/**
 * Turning a stored notification into a sentence.
 *
 * The row is written by Postgres, which knows what happened and nothing about
 * who will read it. Language and currency formatting are decided here, at the
 * moment somebody opens their inbox — which is also the only moment at which
 * either is knowable.
 */

import { describe, expect, it } from 'vitest';

import { COPY, renderNotification } from '../src/index';

const TRIP = { group: 'Goa', amount: '42000', currency: 'INR' };

/** Every language the app offers a picker for. */
const SPOKEN = ['en', 'ta', 'hi', 'ar'] as const;

describe('reading a notification', () => {
  it('fills in the group it is about', () => {
    const { body } = renderNotification('trip_nudge_evening', TRIP, 'en-IN');
    expect(body).toContain('Goa');
    expect(body).not.toContain('{group}');
  });

  it('formats minor units as money, in the reader’s locale', () => {
    // 42000 paise is ₹420.00, and the row has no idea of either fact.
    const { body } = renderNotification('settlement_confirmed', TRIP, 'en-IN');
    expect(body).toContain('420');
    expect(body).not.toContain('42000');
  });

  it('reads in Tamil when that is what the reader uses', () => {
    const { title } = renderNotification('trip_nudge_morning', TRIP, 'ta-IN');
    const english = renderNotification('trip_nudge_morning', TRIP, 'en-IN');
    expect(title).not.toBe(english.title);
  });

  it('reads in Arabic when that is what the reader uses', () => {
    // Arabic shipped in the app four screens before it shipped here, and the
    // gap was invisible: `copyFor` fell through to English and sent it to
    // somebody whose entire app was in Arabic.
    const { title } = renderNotification('trip_nudge_morning', TRIP, 'ar-AE');
    const english = renderNotification('trip_nudge_morning', TRIP, 'en-IN');
    expect(title).not.toBe(english.title);
    expect(title).toMatch(/\p{Script=Arabic}/u);
  });

  it('falls back to English for a language nobody has translated yet', () => {
    const { title } = renderNotification('trip_nudge_morning', TRIP, 'fr-FR');
    expect(title).toBe(renderNotification('trip_nudge_morning', TRIP, 'en-IN').title);
  });
});

describe('what every language owes', () => {
  /**
   * The fallback in `copyFor` is a kindness to a language nobody has started,
   * and a trap for one somebody has. These two tests are the difference: they
   * fail when a language the picker offers has no table, and when a table has
   * a kind missing rather than quietly borrowing the English one.
   */
  it('has a table for every language the app offers', () => {
    for (const language of SPOKEN) {
      expect(COPY[language], language).toBeDefined();
    }
  });

  it('says every kind, in every language, without leaving it English', () => {
    const kinds = Object.keys(COPY.en.notifications);
    for (const language of SPOKEN) {
      for (const kind of kinds) {
        const entry = COPY[language].notifications[kind as keyof typeof COPY.en.notifications];
        expect(entry?.title.trim(), `${language}.${kind}`).toBeTruthy();
        expect(entry?.body.trim(), `${language}.${kind}`).toBeTruthy();
        if (language !== 'en') {
          expect(entry?.title, `${language}.${kind}`).not.toBe(
            COPY.en.notifications[kind as keyof typeof COPY.en.notifications].title,
          );
        }
      }
    }
  });
});

describe('an older app reading a newer server', () => {
  it('shows what the row said rather than a blank line', () => {
    // The server will grow notification kinds faster than everybody updates.
    const { title, body } = renderNotification('something_invented_next_year', TRIP, 'en-IN', {
      title: 'Settled automatically',
      body: 'Nobody said otherwise for a week',
    });
    expect(title).toBe('Settled automatically');
    expect(body).toBe('Nobody said otherwise for a week');
  });

  it('never prints the word undefined at somebody', () => {
    // A kind that names a fact the row did not carry leaves the placeholder
    // visible, which is odd but honest; `undefined` is neither.
    const rendered = renderNotification('settlement_confirmed', { group: 'Goa' }, 'en-IN');
    expect(`${rendered.title} ${rendered.body}`).not.toContain('undefined');
  });
});
