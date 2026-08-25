/**
 * Coverage for notify-fanout's push half (TDR §7.1).
 *
 * The handler is a pure function over injected boundaries — the service client,
 * an env reader, `fetch`, and the email half — so these tests drive it without
 * Deno, a real scheduler or the Expo endpoint. What they pin:
 *
 *   • the machine-to-machine gate: only a caller holding the service-role key
 *     gets in; everyone else is a 401;
 *   • claim → send → finish accounting: delivered / failed / revoked land in the
 *     right buckets and are handed to `baaki_finish_push`;
 *   • resilience: Expo being unreachable fails the chunk rather than throwing,
 *     and a credential error is surfaced as `misconfigured`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { factsOf, handlePushFanout, type NotifyFanoutDeps } from './handler.ts';

const SERVICE_KEY = 'service-role-key';

type RpcResult = { data?: unknown; error?: { message: string } | null };

/** A service-client mock whose `rpc(name)` is dispatched from a table of results. */
function serviceMock(rpc: Record<string, RpcResult> = {}) {
  return {
    rpc: vi.fn((name: string) => Promise.resolve(rpc[name] ?? { data: null, error: null })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

interface HarnessOptions {
  rpc?: Record<string, RpcResult>;
  fetchImpl?: ReturnType<typeof vi.fn>;
  email?: NotifyFanoutDeps['dispatchEmail'];
  serviceKey?: string | undefined;
}

function harness(options: HarnessOptions = {}) {
  const service = serviceMock(options.rpc);
  const dispatchEmail =
    options.email ?? vi.fn().mockResolvedValue({ claimed: 0, sent: 0, failed: 0, retry: 0 });
  const fetchImpl =
    options.fetchImpl ??
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  const deps: NotifyFanoutDeps = {
    asService: () => service,
    env: (name) => (name === 'SUPABASE_SERVICE_ROLE_KEY' ? options.serviceKey : undefined),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    dispatchEmail,
  };
  return { deps, service, dispatchEmail, fetchImpl };
}

function authorizedRequest(key = SERVICE_KEY) {
  return new Request('https://fn.example/notify-fanout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
  });
}

function claimRow(id: string, tokens: string[]) {
  return {
    id,
    kind: 'settlement_recorded',
    title: 'Settled up',
    body: 'A payment was recorded',
    deep_link: null,
    payload: {},
    locale: 'en',
    tokens,
  };
}

function expoResponse(tickets: unknown[]) {
  return new Response(JSON.stringify({ data: tickets }), { status: 200 });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('factsOf', () => {
  it('extracts the string facts a push may interpolate and drops non-strings', () => {
    expect(
      factsOf({ amount: '12.00', currency: 'INR', count: 3, extra: { nested: true } }),
    ).toEqual({
      amount: '12.00',
      currency: 'INR',
      counterparty: undefined,
      group: undefined,
      description: undefined,
      count: undefined, // a number, not a string → dropped
    });
  });
});

describe('the machine-to-machine gate', () => {
  it('401s when no service key is configured', async () => {
    const { deps } = harness({ serviceKey: undefined });
    const response = await handlePushFanout(authorizedRequest(), deps);
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('NOT_AUTHORISED');
  });

  it('401s a caller whose bearer token is not the service key', async () => {
    const { deps, service } = harness({ serviceKey: SERVICE_KEY });
    const response = await handlePushFanout(authorizedRequest('a-user-jwt'), deps);
    expect(response.status).toBe(401);
    expect(service.rpc).not.toHaveBeenCalled();
  });

  it('401s a request with no Authorization header at all', async () => {
    const { deps } = harness({ serviceKey: SERVICE_KEY });
    const response = await handlePushFanout(
      new Request('https://fn.example/notify-fanout', { method: 'POST' }),
      deps,
    );
    expect(response.status).toBe(401);
  });
});

describe('claim → send → finish', () => {
  it('with nobody to buzz, still runs the email half and reports zero', async () => {
    const { deps, dispatchEmail } = harness({
      serviceKey: SERVICE_KEY,
      rpc: { baaki_claim_push_notifications: { data: [] } },
    });
    const response = await handlePushFanout(authorizedRequest(), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ claimed: 0, sent: 0 });
    expect(dispatchEmail).toHaveBeenCalledOnce();
  });

  it('marks a notification delivered when a device accepts it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(expoResponse([{ status: 'ok', id: 'r-1' }]));
    const { deps, service } = harness({
      serviceKey: SERVICE_KEY,
      rpc: {
        baaki_claim_push_notifications: { data: [claimRow('n-1', ['ExponentPushToken[a]'])] },
      },
      fetchImpl,
    });
    const response = await handlePushFanout(authorizedRequest(), deps);
    const body = await response.json();
    expect(body).toMatchObject({ claimed: 1, sent: 1, failed: 0, revoked: 0 });
    expect(service.rpc).toHaveBeenCalledWith(
      'baaki_finish_push',
      expect.objectContaining({ p_delivered: ['n-1'], p_failed: [], p_revoke: [] }),
    );
  });

  it('revokes a dead token and fails its notification on DeviceNotRegistered', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        expoResponse([{ status: 'error', details: { error: 'DeviceNotRegistered' } }]),
      );
    const { deps, service } = harness({
      serviceKey: SERVICE_KEY,
      rpc: {
        baaki_claim_push_notifications: { data: [claimRow('n-2', ['ExponentPushToken[dead]'])] },
      },
      fetchImpl,
    });
    const response = await handlePushFanout(authorizedRequest(), deps);
    expect(await response.json()).toMatchObject({ sent: 0, failed: 1, revoked: 1 });
    expect(service.rpc).toHaveBeenCalledWith(
      'baaki_finish_push',
      expect.objectContaining({ p_revoke: ['ExponentPushToken[dead]'], p_failed: ['n-2'] }),
    );
  });

  it('fails the chunk without throwing when Expo is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const { deps, service } = harness({
      serviceKey: SERVICE_KEY,
      rpc: {
        baaki_claim_push_notifications: { data: [claimRow('n-3', ['ExponentPushToken[a]'])] },
      },
      fetchImpl,
    });
    const response = await handlePushFanout(authorizedRequest(), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sent: 0, failed: 1 });
    // The rows are still closed out so a redelivery does not double-send.
    expect(service.rpc).toHaveBeenCalledWith('baaki_finish_push', expect.any(Object));
  });

  it('flags a credential problem as misconfigured', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        expoResponse([{ status: 'error', details: { error: 'MismatchSenderId' } }]),
      );
    const { deps } = harness({
      serviceKey: SERVICE_KEY,
      rpc: {
        baaki_claim_push_notifications: { data: [claimRow('n-4', ['ExponentPushToken[a]'])] },
      },
      fetchImpl,
    });
    const response = await handlePushFanout(authorizedRequest(), deps);
    const body = await response.json();
    expect(body.misconfigured).toBe(true);
    expect(body.problems).toContainEqual({ error: 'MismatchSenderId', count: 1 });
  });
});

describe('claim / finish failures', () => {
  it('500s CLAIM_FAILED when the claim RPC errors', async () => {
    const { deps } = harness({
      serviceKey: SERVICE_KEY,
      rpc: { baaki_claim_push_notifications: { data: null, error: { message: 'boom' } } },
    });
    const response = await handlePushFanout(authorizedRequest(), deps);
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe('CLAIM_FAILED');
  });

  it('500s FINISH_FAILED when closing the rows out errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(expoResponse([{ status: 'ok' }]));
    const { deps } = harness({
      serviceKey: SERVICE_KEY,
      rpc: {
        baaki_claim_push_notifications: { data: [claimRow('n-5', ['ExponentPushToken[a]'])] },
        baaki_finish_push: { data: null, error: { message: 'finish boom' } },
      },
      fetchImpl,
    });
    const response = await handlePushFanout(authorizedRequest(), deps);
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe('FINISH_FAILED');
  });
});
