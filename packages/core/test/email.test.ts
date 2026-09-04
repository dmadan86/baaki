import { describe, expect, it } from 'vitest';

import {
  buildEmail,
  escapeHtml,
  normaliseAddress,
  signUnsubscribe,
  templateForKind,
  unsubscribeUrlFor,
  verifyUnsubscribe,
  verifyWebhookSignature,
  webLinkFor,
} from '../src/notifications/email';

const OPTIONS = {
  webUrl: 'https://waves.example/',
  unsubscribeUrl: 'https://fn.example/email-unsubscribe?address=a%40b.com&sig=deadbeef',
};

const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'settlement_confirm_request',
  title: 'Fallback title',
  body: 'Fallback body',
  deepLink: 'waves://group/22222222-2222-4222-8222-222222222222',
  facts: { amount: '42000', currency: 'INR', counterparty: 'Madan' },
  locale: 'en',
  to: 'a@b.com',
  groupName: 'Goa trip',
};

describe('what may be mailed at all', () => {
  it('mails the four kinds TDR §7.3 allows, plus the no-inbox fallback', () => {
    expect(templateForKind('settlement_confirm_request')).toBe('settlement-confirm');
    expect(templateForKind('settlement_initiated')).toBe('settlement-confirm');
    expect(templateForKind('digest_daily')).toBe('digest');
    expect(templateForKind('nudge')).toBe('nudge');
    // Not in TDR §7.3 — added because there is no in-app inbox any more (#565)
    // to fall back on when the push for it fails.
    expect(templateForKind('group_added')).toBe('group-added');
  });

  /**
   * The point of the whole list. Mailing somebody every time a flatmate buys
   * milk is the Splitwise mistake, and the only thing standing between us and
   * it is that these return null.
   */
  it('refuses routine ledger activity', () => {
    for (const kind of [
      'expense_added',
      'expense_edited',
      'expense_deleted',
      'you_owe',
      'group_invite_accepted',
      'ghost_claimed',
      'settlement_confirmed',
    ]) {
      expect(templateForKind(kind), kind).toBeNull();
    }
  });

  it('builds nothing for a kind it will not mail', () => {
    expect(buildEmail({ ...ROW, kind: 'expense_added' }, OPTIONS)).toBeNull();
  });
});

describe('what the mail says', () => {
  it('says the same sentence as the inbox, with the amount formatted', () => {
    const built = buildEmail(ROW, OPTIONS);
    expect(built?.subject).toContain('Madan');
    expect(built?.subject).toContain('420');
    // Not the English fallback stored on the row.
    expect(built?.subject).not.toBe('Fallback title');
  });

  it('falls back to the stored English when the kind is one it does not know', () => {
    // `nudge` is mailable, so it gets through; the facts it wants are absent.
    const built = buildEmail({ ...ROW, kind: 'nudge', facts: {} }, OPTIONS);
    expect(built?.subject).toBeTruthy();
  });

  it('writes Arabic right to left', () => {
    const built = buildEmail({ ...ROW, locale: 'ar' }, OPTIONS);
    expect(built?.html).toContain('dir="rtl"');
    expect(built?.html).toContain('text-align:right');
  });

  it('writes everything else left to right', () => {
    for (const locale of ['en', 'ta', 'hi']) {
      expect(buildEmail({ ...ROW, locale }, OPTIONS)?.html, locale).toContain('dir="ltr"');
    }
  });

  it('offers to confirm on a settlement and to open on everything else', () => {
    const settlement = buildEmail(ROW, OPTIONS);
    const digest = buildEmail({ ...ROW, kind: 'digest_daily' }, OPTIONS);
    expect(settlement?.html).toContain('Confirm you received it');
    expect(digest?.html).toContain('Open Waves');
  });

  it('names the group in the footer, so the reason is on the mail', () => {
    expect(buildEmail(ROW, OPTIONS)?.html).toContain('Goa trip');
  });

  it('always carries a plain-text part', () => {
    const built = buildEmail(ROW, OPTIONS);
    expect(built?.text).toContain('Madan');
    expect(built?.text).not.toContain('<');
  });

  /**
   * A group called `<script>` is a group somebody named, and it reaches this
   * function through the notification row without ever passing an HTML encoder.
   */
  it('escapes what people typed', () => {
    const built = buildEmail({ ...ROW, groupName: '<script>alert(1)</script>' }, OPTIONS);
    expect(built?.html).not.toContain('<script>');
    expect(built?.html).toContain('&lt;script&gt;');
  });

  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('the unsubscribe headers', () => {
  it('sends both, because one without the other is not one-click', () => {
    const built = buildEmail(ROW, OPTIONS);
    expect(built?.headers['List-Unsubscribe']).toBe(`<${OPTIONS.unsubscribeUrl}>`);
    expect(built?.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('puts the link in the body too, for people who look for it there', () => {
    expect(buildEmail(ROW, OPTIONS)?.html).toContain('email-unsubscribe');
  });
});

describe('where the button goes', () => {
  it('rewrites a deep link to the web-lite group page', () => {
    expect(
      webLinkFor('waves://group/22222222-2222-4222-8222-222222222222', 'https://b.example'),
    ).toBe('https://b.example/g/22222222-2222-4222-8222-222222222222');
  });

  it('drops trailing segments web-lite has no page for', () => {
    expect(
      webLinkFor(
        'waves://group/22222222-2222-4222-8222-222222222222/expense/x',
        'https://b.example',
      ),
    ).toBe('https://b.example/g/22222222-2222-4222-8222-222222222222');
  });

  it('does not double the slash when the base has one', () => {
    expect(webLinkFor(null, 'https://b.example/')).toBe('https://b.example');
  });

  /**
   * Web-lite is not deployed. Until it is, the button has to be the deep link
   * or nothing — an `https://` URL that 404s looks like it should have worked.
   */
  it('falls back to the deep link when there is no web URL', () => {
    expect(webLinkFor('waves://group/x', null)).toBe('waves://group/x');
  });

  it('renders no button at all when there is nowhere to send anyone', () => {
    const built = buildEmail(
      { ...ROW, deepLink: null },
      { unsubscribeUrl: OPTIONS.unsubscribeUrl },
    );
    expect(built?.html).not.toContain('Confirm you received it');
    // The sentence still goes out; that is the part worth mailing.
    expect(built?.subject).toContain('Madan');
  });

  it('leaves an https deep link alone', () => {
    expect(webLinkFor('https://elsewhere.example/x', 'https://b.example')).toBe(
      'https://elsewhere.example/x',
    );
  });
});

describe('proving an address without a session', () => {
  const SECRET = 'a-secret-that-is-not-the-service-key';

  it('accepts its own signature', async () => {
    const signature = await signUnsubscribe('Someone@Example.com', SECRET);
    expect(await verifyUnsubscribe('someone@example.com', signature, SECRET)).toBe(true);
  });

  it('ignores case and whitespace, because mail clients do not preserve them', async () => {
    const signature = await signUnsubscribe('someone@example.com', SECRET);
    expect(await verifyUnsubscribe('  SOMEONE@EXAMPLE.COM ', signature, SECRET)).toBe(true);
  });

  /** The reason the signature exists: one address's link must not free another. */
  it('refuses a signature made for somebody else', async () => {
    const signature = await signUnsubscribe('someone@example.com', SECRET);
    expect(await verifyUnsubscribe('victim@example.com', signature, SECRET)).toBe(false);
  });

  it('refuses a signature made with a different secret', async () => {
    const signature = await signUnsubscribe('someone@example.com', 'other');
    expect(await verifyUnsubscribe('someone@example.com', signature, SECRET)).toBe(false);
  });

  it('refuses a truncated signature rather than matching its prefix', async () => {
    const signature = await signUnsubscribe('someone@example.com', SECRET);
    expect(await verifyUnsubscribe('someone@example.com', signature.slice(0, 20), SECRET)).toBe(
      false,
    );
  });

  it('normalises the address the same way everywhere', () => {
    expect(normaliseAddress('  A@B.COM ')).toBe('a@b.com');
  });

  it('encodes the address into the URL rather than trusting it raw', () => {
    const url = unsubscribeUrlFor('https://fn.example/functions/v1/', 'a+b@c.com', 'abc');
    expect(url).toContain('address=a%2Bb%40c.com');
    expect(url).toContain('sig=abc');
    expect(url).not.toContain('//email-unsubscribe');
  });
});

/**
 * The signature on Resend's webhook is the entire security of an endpoint
 * anybody on the internet can reach — it runs with `verify_jwt = false`, so
 * there is nothing else between a stranger and `waves_record_email_event`.
 *
 * Getting it subtly wrong fails in the direction nobody notices: every genuine
 * delivery report is answered 401, Resend gives up after a while, and the
 * suppression list freezes at whatever it happened to hold. No error, no alert,
 * just mail continuing to go to addresses that bounced last month. So it is
 * checked here against the vector Svix publishes, rather than against my own
 * reading of the spec.
 */
describe('the webhook signature', () => {
  // Svix's published test vector.
  const VECTOR = {
    secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
    id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    timestamp: '1614265330',
    body: '{"test": 2432232314}',
    header: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  };
  const AT_THE_TIME = Number(VECTOR.timestamp);

  it('accepts the vector Svix publishes', async () => {
    expect(await verifyWebhookSignature({ ...VECTOR, now: AT_THE_TIME })).toBe(true);
  });

  it('refuses a body that was edited after it was signed', async () => {
    expect(
      await verifyWebhookSignature({
        ...VECTOR,
        body: '{"test": 2432232315}',
        now: AT_THE_TIME,
      }),
    ).toBe(false);
  });

  it('refuses a signature made with a different secret', async () => {
    expect(
      await verifyWebhookSignature({
        ...VECTOR,
        secret: 'whsec_TWTvHRIrMWvUxwZM6Yw6BLNgiHnvIu6M',
        now: AT_THE_TIME,
      }),
    ).toBe(false);
  });

  it('refuses when the id or the timestamp has been swapped', async () => {
    expect(
      await verifyWebhookSignature({ ...VECTOR, id: 'msg_somethingelse', now: AT_THE_TIME }),
    ).toBe(false);
    expect(
      await verifyWebhookSignature({ ...VECTOR, timestamp: '1614265331', now: AT_THE_TIME + 1 }),
    ).toBe(false);
  });

  /** Replay protection. Without it a captured body stays postable forever. */
  it('refuses a signature older than the tolerance', async () => {
    expect(await verifyWebhookSignature({ ...VECTOR, now: AT_THE_TIME + 301 })).toBe(false);
    expect(await verifyWebhookSignature({ ...VECTOR, now: AT_THE_TIME + 299 })).toBe(true);
  });

  it('refuses a timestamp from the future, not just an old one', async () => {
    expect(await verifyWebhookSignature({ ...VECTOR, now: AT_THE_TIME - 301 })).toBe(false);
  });

  /** A secret mid-rotation means two signatures are valid at once. */
  it('accepts a match anywhere in a multi-signature header', async () => {
    expect(
      await verifyWebhookSignature({
        ...VECTOR,
        header: `v1,aW52YWxpZHNpZ25hdHVyZWJ5dGVzMDAwMDAwMDAwMDAwMDA= ${VECTOR.header}`,
        now: AT_THE_TIME,
      }),
    ).toBe(true);
  });

  it('ignores versions it does not understand', async () => {
    expect(
      await verifyWebhookSignature({
        ...VECTOR,
        header: `v2,${VECTOR.header.split(',')[1]}`,
        now: AT_THE_TIME,
      }),
    ).toBe(false);
  });

  it('refuses an empty or malformed header rather than throwing', async () => {
    for (const header of ['', 'v1,', 'garbage', ',']) {
      expect(await verifyWebhookSignature({ ...VECTOR, header, now: AT_THE_TIME }), header).toBe(
        false,
      );
    }
  });

  it('refuses a timestamp that is not a number', async () => {
    expect(await verifyWebhookSignature({ ...VECTOR, timestamp: 'now', now: AT_THE_TIME })).toBe(
      false,
    );
  });

  /**
   * A secret that cannot be decoded is a misconfiguration, and the safe reading
   * of a signature check that cannot run is that nothing verifies.
   */
  it('refuses rather than throws when the secret is not base64', async () => {
    expect(
      await verifyWebhookSignature({
        ...VECTOR,
        secret: 'whsec_!!!not base64!!!',
        now: AT_THE_TIME,
      }),
    ).toBe(false);
  });

  it('works with the secret given without its whsec_ prefix', async () => {
    expect(
      await verifyWebhookSignature({
        ...VECTOR,
        secret: VECTOR.secret.slice('whsec_'.length),
        now: AT_THE_TIME,
      }),
    ).toBe(true);
  });
});
