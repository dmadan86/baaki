/**
 * Turning a stored notification into a sentence.
 *
 * The row is written by Postgres, which knows what happened and nothing about
 * who will read it. Language and currency formatting are decided here, at the
 * moment somebody opens their inbox — which is also the only moment at which
 * either is knowable.
 */

import { describe, expect, it } from 'vitest';

import { renderNotification } from '../src/index';

const TRIP = { group: 'Goa', amount: '42000', currency: 'INR' };

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

  it('falls back to English for a language nobody has translated yet', () => {
    const { title } = renderNotification('trip_nudge_morning', TRIP, 'fr-FR');
    expect(title).toBe(renderNotification('trip_nudge_morning', TRIP, 'en-IN').title);
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
