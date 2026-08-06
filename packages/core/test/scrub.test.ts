/**
 * What a crash report is allowed to say.
 *
 * These are not tests of a formatter. Every case below is a real payload that
 * would otherwise have been shipped to a third party: an expense description
 * naming who somebody ate with, the phone number an invite was sent to, the UPI
 * handle they pay from, and — worst of the lot — an invite token, which is not
 * merely private but is itself the key to a group.
 *
 * The second block is the other half of the bargain, and just as load-bearing:
 * a report that has been scrubbed until it says nothing is not privacy, it is a
 * useless report that still costs a round trip. Amounts, UUIDs and stack frames
 * have to survive intact or there was no point sending anything.
 */

import { describe, expect, it } from 'vitest';

import { redactText, redactUrl, scrub, REDACTED } from '../src/index';

describe('things that identify a person', () => {
  it('takes out an email address', () => {
    expect(redactText('failed for asha@example.co.in')).toBe('failed for [email]');
  });

  it('takes out a UPI handle, which is not an email but gives away a bank', () => {
    expect(redactText('paying 9876543210@ybl')).toBe('paying [vpa]');
    expect(redactText('paying ravi.k@okaxis')).toBe('paying [vpa]');
  });

  it('takes out a phone number however it was typed', () => {
    for (const written of ['+919876543210', '+91 98765 43210', '+91-98765-43210']) {
      expect(redactText(`invited ${written}`)).toBe('invited [phone]');
    }
  });

  it('takes out an invite token, which is a key and not just a secret', () => {
    // 64 base36 characters, exactly what invite-mint returns. Anybody reading
    // this in a bug report could join the group.
    const token = 'a'.repeat(40) + '9k3m2p1q8z';
    expect(redactText(`GET /join/${token}`)).toBe('GET /join/[token]');
  });
});

describe('things that are the whole reason to send a report', () => {
  it('keeps the numbers that are the diagnosis', () => {
    // The bug found in the split wire read exactly like this.
    expect(redactText('Exact shares sum to 40000 but the expense is 45000')).toBe(
      'Exact shares sum to 40000 but the expense is 45000',
    );
  });

  it('keeps a bare ten-digit run, because that is money and not a phone number', () => {
    // `normalisePhone` refuses a number without a country code, so a digit run
    // with no `+` in front of it is never a phone number in Baaki.
    expect(redactText('amount 1000000000')).toBe('amount 1000000000');
  });

  it('keeps a UUID, which points at the row without disclosing it', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(redactText(`group ${id} failed`)).toBe(`group ${id} failed`);
  });

  it('keeps the ids a report is filed under', () => {
    // Sentry's own event_id and trace_id are 32 hex characters, which is
    // exactly the shape of an opaque token. Redacting one detaches the report
    // from its own trace.
    const event = { event_id: 'f8e92a2994cf4cb69eaa3585d4c1b207' };
    expect(scrub(event)).toEqual(event);
  });

  it('keeps the platform, which is often the whole pattern', () => {
    // "only on Android 13" is a finding. `device` is not here on purpose: it
    // carries a name, and a phone is usually named after its owner.
    const contexts = { os: { name: 'Android', version: '13' }, runtime: { name: 'hermes' } };
    expect(scrub({ contexts }).contexts).toEqual(contexts);
  });

  it('takes the row out of what Postgres quoted back', () => {
    // This message arrives through PostgREST into an edge function's
    // `error.message` with somebody's group name inside it, and nobody wrote
    // it by hand.
    expect(redactText('Key (name)=(Goa trip) already exists')).toBe(
      `Key (name)=(${REDACTED}) already exists`,
    );
  });

  it('keeps stack frames readable', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'SplitError',
            value: 'Exact shares sum to 40000 but the expense is 45000',
            stacktrace: {
              frames: [
                {
                  filename: 'app:///index.android.bundle',
                  abs_path: '/data/user/0/app.baaki.mobile/files/8f3aa91c4d5e6b7a8c9d0e1f2a3b4c5d',
                  function: 'computeShares',
                },
              ],
            },
          },
        ],
      },
    };
    // The build hash in `abs_path` is opaque enough to look like a token; a
    // report that redacted it would say a crash happened somewhere.
    expect(scrub(event)).toEqual(event);
  });
});

describe('URLs, where the private part travels in the query string', () => {
  it('drops the query, which is where PostgREST puts the filter', () => {
    expect(
      redactUrl('https://x.supabase.co/rest/v1/expenses?description=eq.Dinner%20with%20Asha'),
    ).toBe(`https://x.supabase.co/rest/v1/expenses?${REDACTED}`);
  });

  it('keeps the path, which is the endpoint that broke', () => {
    expect(redactUrl('https://x.supabase.co/functions/v1/expense-write')).toBe(
      'https://x.supabase.co/functions/v1/expense-write',
    );
  });

  it('redacts a URL wherever it is found in an event, not only at the top', () => {
    const scrubbed = scrub({
      breadcrumbs: [{ data: { url: 'https://x.supabase.co/rest/v1/groups?name=eq.Goa%20trip' } }],
    });
    expect(JSON.stringify(scrubbed)).not.toContain('Goa');
  });
});

describe('walking an event', () => {
  it('replaces content outright rather than trying to make it safe', () => {
    const scrubbed = scrub({
      extra: {
        description: 'Dinner with Asha',
        groupName: 'Goa trip',
        amount: '45000',
      },
    });
    expect(scrubbed).toEqual({
      extra: { description: REDACTED, groupName: 'Goa trip', amount: '45000' },
    });
  });

  it('matches a key however the layer that produced it spelled it', () => {
    // Some of an event comes from the app in camelCase and some from the
    // database in snake_case, and both name the same private thing.
    const scrubbed = scrub({ invite_phone: '+919876543210', rawText: 'BILL TOTAL 450' });
    expect(scrubbed).toEqual({ invite_phone: REDACTED, rawText: REDACTED });
  });

  it('keeps the shape, so what is left is still readable', () => {
    const scrubbed = scrub({ members: [{ id: 'm1', name: 'Ravi' }] });
    expect(scrubbed).toEqual({ members: [{ id: 'm1', name: REDACTED }] });
  });

  it('does not hang on an event that refers to itself', () => {
    const event: Record<string, unknown> = { level: 'error' };
    event.self = event;
    expect(scrub(event)).toEqual({ level: 'error', self: REDACTED });
  });

  it('leaves an object it cannot safely copy alone', () => {
    // Half-copying a Date or an Error produces something that looks like data
    // and is not.
    const when = new Date('2026-08-06T00:00:00Z');
    expect(scrub({ when }).when).toBe(when);
  });
});
