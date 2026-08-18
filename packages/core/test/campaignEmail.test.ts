/**
 * A campaign, rendered as mail (A21's broadcast half).
 *
 * The audience, the holdout and the suppression check are all in SQL and tested
 * there; nothing this renderer does decides who gets a mail. What is checked
 * here is what the mail carries — the words come through unaltered and escaped,
 * the button points where it should, the promo code is shown to type, and the
 * one-click unsubscribe headers bulk mail cannot ship without are present.
 */

import { describe, expect, it } from 'vitest';

import { campaignCtaUrl, renderCampaignEmail } from '../src/notifications/campaign';

const base = {
  sendId: 'send-1',
  title: 'Two months of Plus, free',
  body: 'Because you have been here a while.',
  ctaLabel: 'Claim it',
  promoCode: 'DIWALI26',
  locale: 'en',
  to: 'reader@example.com',
} as const;

const options = { webUrl: 'https://baaki.example', unsubscribeUrl: 'https://fn/unsub?sig=abc' };

describe('renderCampaignEmail', () => {
  it('carries the announcement through as the subject and body', () => {
    const mail = renderCampaignEmail(base, options);
    expect(mail.subject).toBe(base.title);
    expect(mail.html).toContain('Because you have been here a while.');
    expect(mail.text).toContain(base.title);
    expect(mail.text).toContain(base.body);
  });

  it('shows the promo code to type and links the button', () => {
    const mail = renderCampaignEmail(base, options);
    expect(mail.html).toContain('DIWALI26');
    // Button lands on the configured web URL, not a dead deep link.
    expect(mail.html).toContain('href="https://baaki.example"');
    expect(mail.html).toContain('Claim it');
  });

  it('always ships one-click unsubscribe headers — it is bulk mail', () => {
    const mail = renderCampaignEmail(base, options);
    expect(mail.headers['List-Unsubscribe']).toBe('<https://fn/unsub?sig=abc>');
    expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail.html).toContain('https://fn/unsub?sig=abc');
  });

  it('escapes anything the campaign author typed, so a title cannot inject markup', () => {
    const mail = renderCampaignEmail(
      { ...base, title: '<script>alert(1)</script>', promoCode: null, ctaLabel: '' },
      options,
    );
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('renders no button when there is nothing to act on', () => {
    const mail = renderCampaignEmail({ ...base, ctaLabel: '', promoCode: null }, options);
    // No call to action, no button, but still a mail worth reading.
    expect(mail.html).not.toContain('<a href="https://baaki.example"');
    expect(mail.html).toContain(base.body);
  });

  it('lays out right-to-left for an Arabic recipient', () => {
    const mail = renderCampaignEmail({ ...base, locale: 'ar' }, options);
    expect(mail.html).toContain('dir="rtl"');
    // The footer reason is the Arabic one, not a group line that names nothing.
    expect(mail.html).toContain('باقي');
  });

  it('names no group in the footer — a campaign has none', () => {
    const mail = renderCampaignEmail(base, options);
    expect(mail.html).toContain('because you use Baaki');
    expect(mail.html).not.toContain('{group}');
  });
});

describe('campaignCtaUrl', () => {
  it('prefers a configured web URL, trimmed of a trailing slash', () => {
    expect(campaignCtaUrl('DIWALI26', 'https://baaki.example/')).toBe('https://baaki.example');
  });

  it('falls back to a redeem deep link when only a code is known', () => {
    expect(campaignCtaUrl('DIWALI 26', null)).toBe('waves://redeem?code=DIWALI%2026');
  });

  it('has nothing to link to with neither', () => {
    expect(campaignCtaUrl(null, null)).toBeNull();
  });
});
