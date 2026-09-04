/**
 * Coverage for the edge email provider seam.
 *
 * The renderer tests in @waves/core prove what the mail says. These tests pin
 * the part only the edge function owns: which provider is selected, which wire
 * shape is sent, and whether provider failures become retryable or terminal.
 * That matters to all the people the same notification can reach — a rider
 * added to a group, a traveller waiting on a settlement, and a financer sending
 * a campaign all share this one sender.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmailTemplate } from './core.js';
import {
  emailConfigured,
  emailKeyName,
  emailProvider,
  sendCampaignEmail,
  sendEmail,
  type CampaignSendResult,
  type EmailResult,
} from './email.ts';

const BUILT_EMAIL = {
  notificationId: 'notification-1',
  to: 'traveller@example.com',
  subject: 'Settlement recorded',
  html: '<p>Paid</p>',
  text: 'Paid',
  template: EmailTemplate.SettlementConfirm,
  headers: {
    'List-Unsubscribe': '<https://fn.example/unsub>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  },
} as const;

const BUILT_CAMPAIGN = {
  sendId: 'campaign-send-1',
  to: 'financer@example.com',
  subject: 'Try Baaki Pro',
  html: '<p>Offer</p>',
  text: 'Offer',
  headers: {
    'List-Unsubscribe': '<https://fn.example/unsub>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  },
} as const;

function configure(provider: 'resend' | 'sendgrid' = 'resend'): void {
  vi.stubEnv('EMAIL_PROVIDER', provider);
  vi.stubEnv('RESEND_API_KEY', 're_key');
  vi.stubEnv('SENDGRID_API_KEY', 'sg_key');
  vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', 'unsubscribe-secret');
  vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co');
}

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchImpl = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('email provider configuration', () => {
  it('defaults to Resend and asks for the Resend key', () => {
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', 'unsubscribe-secret');
    vi.stubEnv('RESEND_API_KEY', 're_key');

    expect(emailProvider()).toBe('resend');
    expect(emailKeyName()).toBe('RESEND_API_KEY');
    expect(emailConfigured()).toBe(true);
  });

  it('selects SendGrid and asks for the SendGrid key', () => {
    configure('sendgrid');

    expect(emailProvider()).toBe('sendgrid');
    expect(emailKeyName()).toBe('SENDGRID_API_KEY');
    expect(emailConfigured()).toBe(true);
  });

  it('refuses an unknown provider instead of silently treating email as off', () => {
    vi.stubEnv('EMAIL_PROVIDER', 'sendgird');
    vi.stubEnv('EMAIL_UNSUBSCRIBE_SECRET', 'unsubscribe-secret');
    vi.stubEnv('RESEND_API_KEY', 're_key');

    expect(() => emailProvider()).toThrow(/sendgird/);
    expect(() => emailConfigured()).toThrow(/sendgird/);
  });
});

describe('sendEmail', () => {
  it('sends a traveller settlement through Resend with the notification id as idempotency key', async () => {
    configure('resend');
    const fetchImpl = stubFetch(new Response(JSON.stringify({ id: 're_1' }), { status: 200 }));

    await expect(sendEmail(BUILT_EMAIL)).resolves.toEqual<EmailResult>({
      id: 'notification-1',
      status: 'sent',
      resend_email_id: 're_1',
      template: EmailTemplate.SettlementConfirm,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer re_key',
      'Idempotency-Key': 'notification-1',
    });
    const body = JSON.parse(init.body as string) as { to: string[]; subject: string };
    expect(body.to).toEqual(['traveller@example.com']);
    expect(body.subject).toBe('Settlement recorded');
  });

  it('sends a rider group notification through SendGrid and carries the id as custom args', async () => {
    configure('sendgrid');
    const fetchImpl = stubFetch(
      new Response('', { status: 202, headers: { 'x-message-id': 'sg_1' } }),
    );

    await expect(
      sendEmail({ ...BUILT_EMAIL, to: 'rider@example.com' }),
    ).resolves.toEqual<EmailResult>({
      id: 'notification-1',
      status: 'sent',
      resend_email_id: 'sg_1',
      template: EmailTemplate.SettlementConfirm,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sg_key' });
    const body = JSON.parse(init.body as string) as {
      personalizations: Array<{ to: Array<{ email: string }>; custom_args: { waves_key: string } }>;
      from: { email: string; name?: string };
      content: Array<{ type: string; value: string }>;
    };
    expect(body.personalizations[0]).toEqual({
      to: [{ email: 'rider@example.com' }],
      custom_args: { waves_key: 'notification-1' },
    });
    expect(body.from).toEqual({ email: 'hello@mail.dmadan.com', name: 'Baaki' });
    expect(body.content.map((part) => part.type)).toEqual(['text/plain', 'text/html']);
  });

  it('retries SendGrid rate limits and fails permanent refusals', async () => {
    configure('sendgrid');
    stubFetch(
      new Response(JSON.stringify({ errors: [{ field: 'to', message: 'try later' }] }), {
        status: 429,
      }),
    );

    await expect(sendEmail(BUILT_EMAIL)).resolves.toMatchObject({
      status: 'retry',
      error: '429 to try later',
    });

    stubFetch(
      new Response(JSON.stringify({ errors: [{ field: 'to', message: 'bad address' }] }), {
        status: 400,
      }),
    );

    await expect(sendEmail(BUILT_EMAIL)).resolves.toMatchObject({
      status: 'failed',
      error: '400 to bad address',
    });
  });
});

describe('sendCampaignEmail', () => {
  it('sends a financer campaign through SendGrid with the send row id as custom args', async () => {
    configure('sendgrid');
    const fetchImpl = stubFetch(new Response('', { status: 202 }));

    const result = await sendCampaignEmail(BUILT_CAMPAIGN);
    expect(result).toMatchObject<CampaignSendResult>({
      id: 'campaign-send-1',
      status: 'sent',
    });
    expect(result.resend_email_id).toBeUndefined();

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      personalizations: Array<{ to: Array<{ email: string }>; custom_args: { waves_key: string } }>;
    };
    expect(body.personalizations[0]).toEqual({
      to: [{ email: 'financer@example.com' }],
      custom_args: { waves_key: 'campaign-send-1' },
    });
  });
});
