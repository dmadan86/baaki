/**
 * Coverage for invite-mint (ADR-006).
 *
 * The handler is a pure function over injected boundaries (two Supabase clients,
 * the membership check, the rate limiter), so these tests drive it without Deno
 * or a network. What they pin:
 *
 *   • the request gates — wrong method, malformed body, non-member, rate limit,
 *     and the per-group live-link cap all become the right deterministic 4xx;
 *   • the token is non-enumerating: the raw token is returned to the caller but
 *     only its SHA-256 hash is ever written to the row, and two mints never
 *     collide, so a leaked `invites` row cannot be replayed;
 *   • the expiry and use limits are clamped to their ceilings.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleInviteMint, type InviteMintDeps } from './handler.ts';

/**
 * A minimal `invites` / `groups` query mock. `from('invites')` serves both the
 * live-link count (`.select(...).eq().is().gt()` awaited) and the insert
 * (`.insert(row).select().single()`); the insert row is captured for assertions.
 */
function serviceMock(options: {
  liveCount?: number | null;
  insert?: { data: { id: string } | null; error: { message: string } | null };
  groupName?: string | null;
}) {
  const insertSpy = vi.fn();
  const invites = {
    select: () => invites,
    eq: () => invites,
    is: () => invites,
    gt: () => invites,
    // Awaiting the count chain yields `{ count }`.
    then: (resolve: (v: { count: number | null }) => unknown) =>
      resolve({ count: options.liveCount ?? 0 }),
    insert: (row: unknown) => {
      insertSpy(row);
      return {
        select: () => ({
          single: () =>
            Promise.resolve(options.insert ?? { data: { id: 'invite-1' }, error: null }),
        }),
      };
    },
  };
  const groups = {
    select: () => groups,
    eq: () => groups,
    single: () =>
      Promise.resolve({
        data: { name: options.groupName === undefined ? 'Goa Trip' : options.groupName },
        error: null,
      }),
  };
  const service = {
    from: vi.fn((table: string) => (table === 'invites' ? invites : groups)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { service, insertSpy };
}

interface HarnessOptions {
  member?: boolean;
  rateLimited?: boolean;
  liveCount?: number | null;
  insert?: { data: { id: string } | null; error: { message: string } | null };
  groupName?: string | null;
}

function harness(options: HarnessOptions = {}) {
  const { service, insertSpy } = serviceMock(options);
  const requireMembership = vi.fn(
    async (_caller: unknown, groupId: string): Promise<{ profileId: string; memberId: string }> => {
      // Mirror the real check: no group / not a member → a 403, never a throw-through.
      if (!groupId || options.member === false) {
        const { HttpError } = await import('../_shared/auth.ts');
        throw new HttpError(403, 'NOT_A_MEMBER', 'You are not a member of this group');
      }
      return { profileId: 'user-1', memberId: 'member-1' };
    },
  );
  const enforceRateLimit = vi.fn(async () => {
    if (options.rateLimited) {
      const { HttpError } = await import('../_shared/auth.ts');
      throw new HttpError(429, 'RATE_LIMITED', 'too fast', { 'Retry-After': '30' });
    }
  });
  const deps: InviteMintDeps = {
    asCaller: () => ({}) as never,
    asService: () => service,
    requireMembership,
    enforceRateLimit,
  };
  return { deps, service, insertSpy, requireMembership, enforceRateLimit };
}

function mint(body: unknown, method = 'POST') {
  return new Request('https://fn.example/invite-mint', {
    method,
    headers: { Authorization: 'Bearer jwt' },
    // GET/HEAD cannot carry a body; the method gate fires before the body is read.
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('request gates', () => {
  it('405s a non-POST request', async () => {
    const { deps } = harness();
    const response = await handleInviteMint(mint({}, 'GET'), deps);
    expect(response.status).toBe(405);
  });

  it('turns a malformed JSON body into a 4xx, never a 500', async () => {
    const { deps } = harness();
    const response = await handleInviteMint(mint('{ not json'), deps);
    // Empty body → no groupId → the membership check refuses it as a 403.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('403s an authenticated outsider', async () => {
    const { deps } = harness({ member: false });
    const response = await handleInviteMint(mint({ groupId: 'group-1' }), deps);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('NOT_A_MEMBER');
  });

  it('429s when the caller is rate limited', async () => {
    const { deps } = harness({ rateLimited: true });
    const response = await handleInviteMint(mint({ groupId: 'group-1' }), deps);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
  });

  it('429s TOO_MANY_INVITES when the group already has the max live links', async () => {
    const { deps, insertSpy } = harness({ liveCount: 5 });
    const response = await handleInviteMint(mint({ groupId: 'group-1' }), deps);
    expect(response.status).toBe(429);
    expect((await response.json()).code).toBe('TOO_MANY_INVITES');
    // Refused before anything is written.
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe('minting a link', () => {
  it('returns a raw token but only ever stores its SHA-256 hash (non-enumerating)', async () => {
    const { deps, insertSpy } = harness({ liveCount: 0 });
    const response = await handleInviteMint(mint({ groupId: 'group-1' }), deps);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.inviteId).toBe('invite-1');
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBe(43);

    const inserted = insertSpy.mock.calls[0][0] as { token_hash: string; group_id: string };
    // The stored value is a 64-char hex digest, and never the raw token itself.
    expect(inserted.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(inserted.token_hash).not.toBe(body.token);
    expect(inserted.group_id).toBe('group-1');
  });

  it('mints a different token every time (unguessable, no collisions)', async () => {
    const { deps } = harness({ liveCount: 0 });
    const a = await (await handleInviteMint(mint({ groupId: 'group-1' }), deps)).json();
    const b = await (await handleInviteMint(mint({ groupId: 'group-1' }), deps)).json();
    expect(a.token).not.toBe(b.token);
  });

  it('clamps expiry to 30 days and maxUses to 100', async () => {
    const { deps, insertSpy } = harness({ liveCount: 0 });
    const response = await handleInviteMint(
      mint({ groupId: 'group-1', expiresInDays: 999, maxUses: 999 }),
      deps,
    );
    const body = await response.json();
    expect(body.maxUses).toBe(100);

    const inserted = insertSpy.mock.calls[0][0] as { max_uses: number; expires_at: string };
    expect(inserted.max_uses).toBe(100);
    const days = (new Date(inserted.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it('floors maxUses and expiry at 1 (no zero/negative windows)', async () => {
    const { deps, insertSpy } = harness({ liveCount: 0 });
    const response = await handleInviteMint(
      mint({ groupId: 'group-1', expiresInDays: 0, maxUses: 0 }),
      deps,
    );
    expect((await response.json()).maxUses).toBe(1);
    const inserted = insertSpy.mock.calls[0][0] as { max_uses: number; expires_at: string };
    expect(inserted.max_uses).toBe(1);
    const days = (new Date(inserted.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(0.9);
  });

  it('carries the group name into the response, falling back when it is missing', async () => {
    const withName = harness({ liveCount: 0, groupName: 'Beach House' });
    const named = await (
      await handleInviteMint(mint({ groupId: 'group-1' }), withName.deps)
    ).json();
    expect(named.groupName).toBe('Beach House');

    const withoutName = harness({ liveCount: 0, groupName: null });
    const anon = await (
      await handleInviteMint(mint({ groupId: 'group-1' }), withoutName.deps)
    ).json();
    expect(anon.groupName).toBe('a group');
  });

  it('500s when the insert itself fails', async () => {
    const { deps } = harness({
      liveCount: 0,
      insert: { data: null, error: { message: 'db down' } },
    });
    const response = await handleInviteMint(mint({ groupId: 'group-1' }), deps);
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe('INTERNAL');
  });
});
