import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `server-only` throws when imported outside a React Server Component build;
// in the test runner it is a no-op.
vi.mock('server-only', () => ({}));

const rpc = vi.fn();
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ rpc }),
}));

import { clientAddress, recordLoginAttempt } from '@/lib/loginThrottle';

beforeEach(() => {
  rpc.mockReset();
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clientAddress', () => {
  it('takes the first x-forwarded-for entry', () => {
    expect(clientAddress('1.2.3.4, 5.6.7.8')).toBe('1.2.3.4');
    expect(clientAddress(' 9.9.9.9 ')).toBe('9.9.9.9');
    expect(clientAddress(null)).toBe('unknown');
    expect(clientAddress('')).toBe('unknown');
  });
});

describe('recordLoginAttempt', () => {
  it('allows while under the limit', async () => {
    rpc.mockResolvedValue({ data: { allowed: true, retryAfter: 0 }, error: null });
    await expect(recordLoginAttempt('1.2.3.4')).resolves.toEqual({
      allowed: true,
      retryAfter: 0,
    });
    expect(rpc).toHaveBeenCalledWith('baaki_rate_limit', {
      p_subject: 'ip:1.2.3.4',
      p_bucket: 'admin-login',
      p_limit: 10,
      p_window_seconds: 900,
    });
  });

  it('locks out and emits an alert once over the limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpc.mockResolvedValue({ data: { allowed: false, retryAfter: 42 }, error: null });
    await expect(recordLoginAttempt('1.2.3.4')).resolves.toEqual({
      allowed: false,
      retryAfter: 42,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[ALERT] admin-login lockout'));
  });

  it('fails open when the rate-limit RPC errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { message: 'db down' } });
    await expect(recordLoginAttempt('1.2.3.4')).resolves.toEqual({
      allowed: true,
      retryAfter: 0,
    });
  });

  it('fails open when the service key is not configured', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(recordLoginAttempt('1.2.3.4')).resolves.toEqual({
      allowed: true,
      retryAfter: 0,
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});
