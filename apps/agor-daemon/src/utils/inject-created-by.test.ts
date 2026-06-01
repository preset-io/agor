/**
 * Tests for `injectCreatedBy` — the shared before-create hook that stamps
 * `created_by` on sessions/tasks/boards.
 *
 * The threat we're defending against: an authenticated external caller POSTs
 * `/sessions` (or `/tasks`, `/boards`) with `created_by: <victim_user_id>`
 * and the resource ends up attributed to the victim. The hook MUST
 * unconditionally overwrite `created_by` for external calls and MUST NOT
 * trust an absent-or-present client value.
 */

import { NotAuthenticated } from '@agor/core/feathers';
import type { HookContext } from '@feathersjs/feathers';
import { describe, expect, it } from 'vitest';
import { injectCreatedBy } from './inject-created-by';

const ALICE = 'user-alice';
const BOB = 'user-bob';

function makeContext(opts: {
  provider?: string;
  user?: { user_id?: string };
  data?: unknown;
}): HookContext {
  return {
    params: { provider: opts.provider, user: opts.user },
    data: opts.data,
  } as unknown as HookContext;
}

describe('injectCreatedBy', () => {
  const hook = injectCreatedBy();

  describe('external calls (params.provider set)', () => {
    it('overwrites client-supplied created_by with caller user_id', () => {
      // The attack: client POSTs claiming to be Bob; we attribute to Alice.
      const ctx = makeContext({
        provider: 'rest',
        user: { user_id: ALICE },
        data: { title: 'x', created_by: BOB },
      });
      hook(ctx);
      expect((ctx.data as { created_by: string }).created_by).toBe(ALICE);
    });

    it('stamps created_by when missing on external call', () => {
      const ctx = makeContext({
        provider: 'socketio',
        user: { user_id: ALICE },
        data: { title: 'x' },
      });
      hook(ctx);
      expect((ctx.data as { created_by: string }).created_by).toBe(ALICE);
    });

    it('handles array payloads (bulk create)', () => {
      const ctx = makeContext({
        provider: 'rest',
        user: { user_id: ALICE },
        data: [{ title: 'a', created_by: BOB }, { title: 'b' }],
      });
      hook(ctx);
      const items = ctx.data as Array<{ created_by: string }>;
      expect(items[0].created_by).toBe(ALICE);
      expect(items[1].created_by).toBe(ALICE);
    });

    it('throws NotAuthenticated when external call has no user (defence-in-depth)', () => {
      const ctx = makeContext({
        provider: 'rest',
        data: { title: 'x' },
      });
      expect(() => hook(ctx)).toThrow(NotAuthenticated);
    });

    it('throws NotAuthenticated when external call has user without user_id', () => {
      const ctx = makeContext({
        provider: 'rest',
        user: {},
        data: { title: 'x' },
      });
      expect(() => hook(ctx)).toThrow(NotAuthenticated);
    });
  });

  describe('internal calls (no provider)', () => {
    it('respects explicit created_by from internal callers', () => {
      // Scheduler / service-to-service may legitimately set created_by.
      const ctx = makeContext({
        data: { title: 'x', created_by: BOB },
      });
      hook(ctx);
      expect((ctx.data as { created_by: string }).created_by).toBe(BOB);
    });

    it('falls back to caller user_id when internal call omits created_by', () => {
      const ctx = makeContext({
        user: { user_id: ALICE },
        data: { title: 'x' },
      });
      hook(ctx);
      expect((ctx.data as { created_by: string }).created_by).toBe(ALICE);
    });

    it('throws when internal call has no user and no created_by', () => {
      const ctx = makeContext({ data: { title: 'x' } });
      expect(() => hook(ctx)).toThrow(/every row must be attributed to a real user/);
    });
  });

  it('is a no-op when context.data is undefined', () => {
    const ctx = makeContext({ provider: 'rest', user: { user_id: ALICE } });
    expect(() => hook(ctx)).not.toThrow();
  });
});
