import type { Branch, User } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RealtimeAccessBranchRepository,
  RealtimeAccessSessionRepository,
} from './realtime-access-cache';

/**
 * `RealtimePublishAudience` is an eight-member union and will grow. The
 * compile-time guard against forgetting a case is the `never` parameter on
 * `unhandledAudienceScope` — `turbo run typecheck` fails on a new member with
 * no case, which is the primary protection and cannot be exercised at runtime.
 *
 * This is the runtime half: it simulates a future audience (say
 * `'creator-only'`) that reached `resolvePublishScope` without a case — through
 * a cast, a bad merge, or a policy table loaded from somewhere else — and pins
 * that delivery narrows to service connections rather than widening to the
 * whole tenant. In a file whose thesis is fail-closed, the residual branch has
 * to fail closed too.
 *
 * The policy module is mocked rather than the real table edited, so the real
 * table stays the single source of truth for every other test.
 */
vi.mock('./realtime-publish-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./realtime-publish-policy')>();
  const FUTURE_PATH = 'a-future-service';
  return {
    ...actual,
    isRealtimePublishAllowed: (path: string | null | undefined) =>
      path === FUTURE_PATH || actual.isRealtimePublishAllowed(path),
    realtimePublishPolicyFor: (path: string | null | undefined) =>
      path === FUTURE_PATH
        ? // Deliberately not a member of the union — this is the shape of a
          // member added to the type without a case in the switch.
          ({ audience: 'creator-only', why: 'a future audience nobody handled' } as never)
        : actual.realtimePublishPolicyFor(path),
  };
});

const { configureRealtimePublish } = await import('./realtime-publish');

class FakeChannel {
  constructor(public connections: unknown[]) {}
  get length() {
    return this.connections.length;
  }
  filter(fn: (connection: unknown) => boolean) {
    return new FakeChannel(this.connections.filter(fn));
  }
}

function makeApp(connections: unknown[]) {
  let publishFn: ((data: unknown, context: unknown) => unknown) | undefined;
  const app = {
    get channels() {
      return ['authenticated'];
    },
    channel: vi.fn(() => new FakeChannel(connections)),
    publish: vi.fn((fn) => {
      publishFn = fn;
    }),
    emit: vi.fn(),
    service: vi.fn(() => {
      throw new Error('no services');
    }),
    async runPublish(data: unknown, context: Record<string, unknown>) {
      if (!publishFn) throw new Error('publish not configured');
      return await publishFn(data, { ...context, app });
    },
  } as any;
  return app;
}

const user = (id: string, role = ROLES.MEMBER): User => ({ user_id: id, role }) as User;

function repos() {
  return {
    branchRepository: {
      findRealtimeVisibilityBranch: vi.fn(async () => ({ branch_id: 'b1' }) as Branch),
      findRealtimeViewUserIds: vi.fn(async () => []),
    } as unknown as RealtimeAccessBranchRepository,
    sessionsRepository: {
      findBranchIdBySessionId: vi.fn(async () => null),
      findCreatedByBySessionId: vi.fn(async () => null),
    } as unknown as RealtimeAccessSessionRepository,
  } as {
    branchRepository: RealtimeAccessBranchRepository;
    sessionsRepository: RealtimeAccessSessionRepository;
  };
}

const delivered = (result: unknown): unknown[] => {
  const channels = (Array.isArray(result) ? result : [result]) as (FakeChannel | undefined)[];
  return [...new Set(channels.flatMap((channel) => channel?.connections ?? []))];
};

describe('resolvePublishScope residual audience', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('does not reach the tenant when an audience has no case', async () => {
    const member = { user: user('u1') };
    const other = { user: user('u2') };
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const app = makeApp([member, other, service]);
    configureRealtimePublish({
      app,
      branchRbacEnabled: true,
      ...(repos() as unknown as {
        branchRepository: never;
        sessionsRepository: never;
      }),
    });

    const result = await app.runPublish(
      { some_id: 'x1', secret: 'should-not-fan-out' },
      { path: 'a-future-service', method: 'patch', event: 'patched', params: {} }
    );

    // Fails closed to service connections — NOT [member, other, service].
    expect(delivered(result)).toEqual([service]);
  });

  it('warns so the unhandled audience is visible rather than silent', async () => {
    const app = makeApp([{ user: user('u1') }]);
    configureRealtimePublish({
      app,
      branchRbacEnabled: true,
      ...(repos() as unknown as {
        branchRepository: never;
        sessionsRepository: never;
      }),
    });

    await app.runPublish(
      { some_id: 'x1' },
      { path: 'a-future-service', method: 'patch', event: 'patched', params: {} }
    );

    expect(warn).toHaveBeenCalledWith(
      '[realtime] Suppressing event with an unhandled publish audience',
      expect.objectContaining({ audience: 'creator-only', path: 'a-future-service' })
    );
  });

  it('still resolves a declared audience normally through the same switch', async () => {
    // Guards the mock: if the passthrough broke, the test above would pass for
    // the wrong reason.
    const member = { user: user('u1') };
    const app = makeApp([member]);
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      ...(repos() as unknown as {
        branchRepository: never;
        sessionsRepository: never;
      }),
    });

    const result = await app.runPublish(
      { board_id: 'bd1' },
      { path: 'boards', method: 'patch', event: 'patched', params: {} }
    );

    expect(delivered(result)).toEqual([member]);
  });
});
