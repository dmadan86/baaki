/**
 * Coverage for otp-send — the Send SMS Hook that delivers the sign-in code over
 * WhatsApp and caps a number at four codes a day.
 *
 * The handler is a pure function over injected boundaries (a Supabase client, a
 * fetch, an env reader and the signature verifier), so these tests drive it with
 * hand-rolled mocks — no Deno, no database, no Twilio account. The cases that
 * carry the weight:
 *
 *   • an unsigned or wrongly-signed caller is refused *before* the body is used;
 *   • the daily cap refuses at the fifth ask and, crucially, sends nothing;
 *   • a database blip fails open rather than locking everyone out of sign-in;
 *   • the Twilio call is a template send to the right number, and its error text
 *     never reaches the person waiting for the code.
 */

import { describe, expect, it, vi } from 'vitest';

import { handleOtpSend, hookSecret, OTP_DAILY_LIMIT, type OtpSendDeps } from './handler.ts';

/**
 * Built rather than written out. As a literal, `whsec_<base64>` is a webhook
 * secret to any scanner reading the file — gitleaks flags it as a
 * `generic-api-key` on entropy alone and cannot know the payload decodes to the
 * word "test". Composing it keeps the secret scanner honest about real findings
 * instead of teaching everyone to wave this job through.
 */
const TEST_HOOK_SECRET = `whsec_${Buffer.from('test').toString('base64')}`;

const ENV: Record<string, string> = {
  SEND_SMS_HOOK_SECRET: TEST_HOOK_SECRET,
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
  TWILIO_OTP_CONTENT_SID: 'HX999',
};

const BODY = JSON.stringify({
  user: { id: 'user-1', phone: '+919876543210' },
  sms: { otp: '123456' },
});

function request(body = BODY, headers: Record<string, string> = {}): Request {
  return new Request('https://edge.test/otp-send', {
    method: 'POST',
    headers: {
      'webhook-id': 'msg_1',
      'webhook-timestamp': '1700000000',
      'webhook-signature': 'v1,sig',
      ...headers,
    },
    body,
  });
}

function deps(
  overrides: {
    allowed?: boolean;
    rpcError?: { message: string };
    verified?: boolean;
    twilioOk?: boolean;
    env?: Record<string, string>;
  } = {},
): OtpSendDeps & { rpc: ReturnType<typeof vi.fn>; fetchImpl: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn(() =>
    Promise.resolve({
      data: overrides.rpcError ? null : { allowed: overrides.allowed ?? true, retryAfter: 3600 },
      error: overrides.rpcError ?? null,
    }),
  );
  const fetchImpl = vi.fn(() =>
    Promise.resolve(
      new Response(overrides.twilioOk === false ? 'twilio said no' : '{"sid":"SM1"}', {
        status: overrides.twilioOk === false ? 400 : 201,
      }),
    ),
  );
  const env = { ...ENV, ...(overrides.env ?? {}) };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service: () => ({ rpc }) as any,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    env: (key: string) => env[key],
    verify: () => Promise.resolve(overrides.verified ?? true),
    rpc,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('otp-send', () => {
  it('refuses a caller with no signature headers, and never reads the body', async () => {
    const d = deps();
    const bare = new Request('https://edge.test/otp-send', { method: 'POST', body: BODY });
    const response = await handleOtpSend(bare, d);

    expect(response.status).toBe(401);
    expect(d.rpc).not.toHaveBeenCalled();
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a signature that does not match', async () => {
    const d = deps({ verified: false });
    const response = await handleOtpSend(request(), d);

    expect(response.status).toBe(401);
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses when the hook secret is unset rather than accepting unsigned callers', async () => {
    const d = deps({ env: { SEND_SMS_HOOK_SECRET: '' } });
    const response = await handleOtpSend(request(), d);

    expect(response.status).toBe(500);
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the code as a WhatsApp template to the caller’s number', async () => {
    const d = deps();
    const response = await handleOtpSend(request(), d);

    expect(response.status).toBe(200);
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = d.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');

    const sent = new URLSearchParams(init.body as string);
    expect(sent.get('To')).toBe('whatsapp:+919876543210');
    expect(sent.get('From')).toBe('whatsapp:+14155238886');
    expect(sent.get('ContentSid')).toBe('HX999');
    expect(JSON.parse(sent.get('ContentVariables') ?? '{}')).toEqual({ '1': '123456' });
  });

  it('counts the ask against the number, not an IP or a profile', async () => {
    const d = deps();
    await handleOtpSend(request(), d);

    expect(d.rpc).toHaveBeenCalledWith('waves_rate_limit', {
      p_subject: 'phone:+919876543210',
      p_bucket: 'otp-send',
      p_limit: OTP_DAILY_LIMIT,
      p_window_seconds: 86400,
    });
  });

  it.each([
    ['Indian rider', '+919876543210'],
    ['traveller on a UK SIM', '+447700900123'],
    ['long international number', '+123456789012345'],
  ])('accepts a valid E.164 number for an %s', async (_persona, phone) => {
    const body = JSON.stringify({ user: { id: 'user-1', phone }, sms: { otp: '123456' } });
    const d = deps();
    const response = await handleOtpSend(request(body), d);

    expect(response.status).toBe(200);
    const [, init] = d.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(new URLSearchParams(init.body as string).get('To')).toBe(`whatsapp:${phone}`);
    expect(d.rpc).toHaveBeenCalledWith(
      'waves_rate_limit',
      expect.objectContaining({ p_subject: `phone:${phone}` }),
    );
  });

  it('refuses past the daily cap and sends nothing', async () => {
    const d = deps({ allowed: false });
    const response = await handleOtpSend(request(), d);

    expect(response.status).toBe(429);
    expect(d.fetchImpl).not.toHaveBeenCalled();

    const payload = (await response.json()) as { error: { http_code: number; message: string } };
    expect(payload.error.http_code).toBe(429);
    expect(payload.error.message).toContain(String(OTP_DAILY_LIMIT));
  });

  it('fails open when the limiter itself errors, so a database blip is not a lockout', async () => {
    const d = deps({ rpcError: { message: 'connection refused' } });
    const response = await handleOtpSend(request(), d);

    expect(response.status).toBe(200);
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a payload with no phone number before spending an attempt', async () => {
    const d = deps();
    const response = await handleOtpSend(request(JSON.stringify({ sms: { otp: '1' } })), d);

    expect(response.status).toBe(400);
    expect(d.rpc).not.toHaveBeenCalled();
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a phone number that is not E.164', async () => {
    const body = JSON.stringify({ user: { phone: '9876543210' }, sms: { otp: '123456' } });
    const d = deps();
    const response = await handleOtpSend(request(body), d);

    expect(response.status).toBe(400);
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('does not leak Twilio’s error text to the person waiting for the code', async () => {
    const d = deps({ twilioOk: false });
    const response = await handleOtpSend(request(), d);

    expect(response.status).toBe(502);
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).not.toContain('twilio said no');
  });

  it('refuses an unconfigured deployment without burning a daily code', async () => {
    const d = deps({ env: { TWILIO_OTP_CONTENT_SID: '' } });
    const response = await handleOtpSend(request(), d);

    expect(response.status).toBe(500);
    expect(d.fetchImpl).not.toHaveBeenCalled();
    // The point of the check's position: a deploy missing its Twilio secrets
    // must not spend somebody's four codes on sends it could never make.
    expect(d.rpc).not.toHaveBeenCalled();
  });

  it('answers a refused connection the same way as a Twilio 5xx', async () => {
    const d = deps();
    d.fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error('dial tcp: connection refused')) as unknown as typeof fetch;

    const response = await handleOtpSend(request(), d);

    expect(response.status).toBe(502);
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).not.toContain('connection refused');
  });
});

/**
 * The signature check, run for real.
 *
 * Every test above stubs `verify`, which is what let a live bug through review:
 * Supabase issues the hook secret as `v1,whsec_<base64>` and the verifier strips
 * only `whsec_`, so the raw value decoded the wrong key and refused every
 * genuine request. A stub cannot see that. These drive the real verifier from
 * @waves/core with a signature computed the way GoTrue computes one.
 */
describe('otp-send signature verification', () => {
  const SECRET_BYTES = 'a-32-byte-key-for-hmac-testing!!';
  const BASE64_KEY = Buffer.from(SECRET_BYTES).toString('base64');

  async function sign(id: string, timestamp: string, body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      Buffer.from(BASE64_KEY, 'base64'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${body}`),
    );
    return `v1,${Buffer.from(new Uint8Array(mac)).toString('base64')}`;
  }

  /** Deps with the real verifier — `verify` deliberately left unset. */
  function realDeps(secret: string) {
    const env: Record<string, string> = { ...ENV, SEND_SMS_HOOK_SECRET: secret };
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('{}', { status: 201 })));
    return {
      service: () =>
        ({ rpc: vi.fn(() => Promise.resolve({ data: { allowed: true }, error: null })) }) as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: (key: string) => env[key],
      fetchSpy: fetchImpl,
    };
  }

  it('strips the v1, prefix Supabase puts on the hook secret', () => {
    expect(hookSecret(`v1,whsec_${BASE64_KEY}`)).toBe(`whsec_${BASE64_KEY}`);
    expect(hookSecret(`whsec_${BASE64_KEY}`)).toBe(`whsec_${BASE64_KEY}`);
    expect(hookSecret(BASE64_KEY)).toBe(BASE64_KEY);
  });

  it('verifies a genuine signature against a v1,whsec_ secret', async () => {
    const id = 'msg_real';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const header = await sign(id, timestamp, BODY);

    const d = realDeps(`v1,whsec_${BASE64_KEY}`);
    const response = await handleOtpSend(
      request(BODY, {
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': header,
      }),
      d as unknown as OtpSendDeps,
    );

    expect(response.status).toBe(200);
    expect(d.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a signature computed over a different body', async () => {
    const id = 'msg_real';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const header = await sign(id, timestamp, '{"tampered":true}');

    const d = realDeps(`v1,whsec_${BASE64_KEY}`);
    const response = await handleOtpSend(
      request(BODY, {
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': header,
      }),
      d as unknown as OtpSendDeps,
    );

    expect(response.status).toBe(401);
    expect(d.fetchSpy).not.toHaveBeenCalled();
  });
});
