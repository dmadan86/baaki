/**
 * That nothing private actually leaves.
 *
 * The scrubber itself is tested in @waves/core, and passing those tests proves
 * only that a pure function works. The question this file asks is the one that
 * matters in production: when the SDK is initialised the way the app
 * initialises it, and a real error is captured, what goes out on the wire?
 *
 * So there is no mocking of `beforeSend` here. Sentry is started with a
 * transport that captures the envelope instead of sending it, an error is
 * thrown with a ledger attached to it, and the bytes are searched for the
 * things that must not be in them. A `beforeSend` wired to the wrong option, or
 * an SDK attaching something the hook does not reach, fails this and passes
 * every unit test — which is exactly what happened the first time this ran.
 */

import * as Sentry from '@sentry/nextjs';
import { beforeAll, describe, expect, it } from 'vitest';

import { scrub } from '@waves/core';

import { DIAGNOSIS, SECRETS } from './fixtures';

const sent: string[] = [];

beforeAll(async () => {
  Sentry.init({
    dsn: 'https://examplePublicKey@o0.ingest.sentry.io/0',
    // Capture the serialised envelope rather than sending it. This is the last
    // point before the network, which is the point worth inspecting.
    transport: () => ({
      send: (envelope) => {
        sent.push(JSON.stringify(envelope));
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    }),
    sendDefaultPii: false,
    beforeSend: (event) => scrub(event),
  });

  Sentry.setUser({ id: DIAGNOSIS.userId });
  Sentry.addBreadcrumb({
    category: 'fetch',
    data: { url: `https://x.supabase.co/rest/v1/expenses?description=eq.${SECRETS.description}` },
  });

  Sentry.captureException(
    // What a real failure looks like: a code, an amount, and a message from
    // Postgres that has quoted a row back at us.
    new Error(
      `EXACT_SUM_MISMATCH after Key (name)=(${SECRETS.description}) already exists; ` +
        `reached ${SECRETS.phone}`,
    ),
    {
      extra: {
        description: SECRETS.description,
        email: SECRETS.email,
        phone: SECRETS.phone,
        vpa: SECRETS.vpa,
        inviteToken: SECRETS.inviteToken,
        ...DIAGNOSIS,
      },
    },
  );

  await Sentry.flush(2000);
});

const wire = (): string => sent.join('\n');

describe('an error that happened while somebody was splitting a bill', () => {
  it('is reported at all', () => {
    expect(sent.length).toBeGreaterThan(0);
  });

  it.each(Object.entries(SECRETS))('carries no %s', (_field, secret) => {
    expect(wire()).not.toContain(secret);
  });

  it('still says how much money was involved', () => {
    expect(wire()).toContain(DIAGNOSIS.amount);
  });

  it('still says whose session it was, as an id and nothing more', () => {
    expect(wire()).toContain(DIAGNOSIS.userId);
  });

  it('still says which platform it happened on', () => {
    // `os.name` is how you find out a crash only happens on one of them.
    expect(wire()).toContain('"os"');
    expect(wire()).not.toContain('"os":{"name":"[redacted]"');
  });

  it('has a limit, and it is this one', () => {
    // A bare name under a key nobody anticipated matches no pattern and is not
    // on the list — there is no rule that can tell "Asha" from "Dinner". The
    // scrubber catches shapes and known fields; it cannot catch a value whose
    // only property is that it belongs to somebody. Which is why the rule for
    // anything that reports an error is: attach ids, never rows.
    const surprise = scrub({ extra: { whoWasThere: SECRETS.who } });
    expect(JSON.stringify(surprise)).toContain(SECRETS.who);
  });

  it('still says what actually went wrong', () => {
    expect(wire()).toContain('EXACT_SUM_MISMATCH');
    // The column is the diagnosis; the value in it was somebody's group.
    expect(wire()).toContain('Key (name)=([redacted])');
  });

  it('keeps the ids Sentry needs to file it', () => {
    // A redacted `event_id` or `trace_id` detaches the report from itself.
    expect(wire()).not.toContain('"event_id":"[token]"');
    expect(wire()).not.toContain('"trace_id":"[token]"');
  });
});
