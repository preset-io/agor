import type { BranchRepository, SessionRepository, UsersRepository } from '@agor/core/db';
import type { Branch, Session, User } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { configureRealtimePublish } from './realtime-publish';

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
  let publishFn: ((data: unknown, context: any) => unknown) | undefined;
  return {
    channel: vi.fn(() => new FakeChannel(connections)),
    publish: vi.fn((fn) => {
      publishFn = fn;
    }),
    async runPublish(data: unknown, context: any) {
      if (!publishFn) throw new Error('publish not configured');
      return (await publishFn(data, context)) as FakeChannel;
    },
  } as any;
}

function user(id: string, role = ROLES.MEMBER): User {
  return { user_id: id, role } as User;
}

function branch(id: string, others_can: Branch['others_can'] = 'none'): Branch {
  return { branch_id: id, others_can } as Branch;
}

function session(id: string, branchId: string): Session {
  return { session_id: id, branch_id: branchId } as Session;
}

function repos(options: {
  branch: Branch;
  session?: Session | null;
  users: User[];
  permissions: Record<string, Branch['others_can']>;
}) {
  const branchRepository = {
    findById: vi.fn(async (id: string) =>
      id === options.branch.branch_id ? options.branch : null
    ),
    resolveUserPermission: vi.fn(
      async (_branch: Branch, userId: string) => options.permissions[userId] ?? 'none'
    ),
  } as unknown as BranchRepository;
  const sessionsRepository = {
    findById: vi.fn(async (id: string) =>
      options.session?.session_id === id ? options.session : null
    ),
  } as unknown as SessionRepository;
  const usersRepository = {
    findAll: vi.fn(async () => options.users),
  } as unknown as UsersRepository;
  return { branchRepository, sessionsRepository, usersRepository };
}

describe('configureRealtimePublish', () => {
  it('preserves legacy authenticated broadcast when branch RBAC is disabled', async () => {
    const app = makeApp([{ user: user('u1') }, { user: user('u2') }]);
    const r = repos({ branch: branch('b1'), users: [], permissions: {} });
    configureRealtimePublish({ app, branchRbacEnabled: false, ...r });

    const channel = await app.runPublish(
      { branch_id: 'b1' },
      { path: 'branches', method: 'patch', event: 'patched' }
    );

    expect(channel.connections).toHaveLength(2);
    expect(r.usersRepository.findAll).not.toHaveBeenCalled();
  });

  it('filters branch events to users with view access when RBAC is enabled', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const admin = user('admin', ROLES.SUPERADMIN);
    const app = makeApp([{ user: allowed }, { user: denied }, { user: admin }]);
    const r = repos({
      branch: branch('b1', 'none'),
      users: [allowed, denied, admin],
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { branch_id: 'b1' },
      { path: 'branches', method: 'patch', event: 'patched' }
    );

    expect(channel.connections).toEqual([{ user: allowed }, { user: admin }]);
  });

  it('resolves task/message events through session_id before filtering', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const app = makeApp([{ user: allowed }, { user: denied }, service]);
    const r = repos({
      branch: branch('b1', 'none'),
      session: session('s1', 'b1'),
      users: [allowed, denied],
      permissions: { allowed: 'session', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { task_id: 't1', session_id: 's1' },
      { path: 'tasks', method: 'create', event: 'created' }
    );

    expect(r.sessionsRepository.findById).toHaveBeenCalledWith('s1');
    expect(channel.connections).toEqual([{ user: allowed }, service]);
  });

  it('resolves custom sessions events through camelCase sessionId', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const app = makeApp([{ user: allowed }, { user: denied }]);
    const r = repos({
      branch: branch('b1', 'none'),
      session: session('s1', 'b1'),
      users: [allowed, denied],
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { requestId: 'r1', sessionId: 's1' },
      { path: 'sessions', method: 'emit', event: 'permission:request' }
    );

    expect(r.sessionsRepository.findById).toHaveBeenCalledWith('s1');
    expect(channel.connections).toEqual([{ user: allowed }]);
  });

  it('filters optional branch-scoped events when they carry branch_id', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const app = makeApp([{ user: allowed }, { user: denied }]);
    const r = repos({
      branch: branch('b1', 'none'),
      users: [allowed, denied],
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { artifact_id: 'a1', branch_id: 'b1' },
      { path: 'artifacts', method: 'patch', event: 'patched' }
    );

    expect(channel.connections).toEqual([{ user: allowed }]);
  });

  it('leaves optional branch-scoped events global when no branch/session is attached', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const app = makeApp([{ user: allowed }, { user: denied }]);
    const r = repos({
      branch: branch('b1', 'none'),
      users: [allowed, denied],
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { card_id: 'card1' },
      { path: 'board-objects', method: 'patch', event: 'patched' }
    );

    expect(channel.connections).toEqual([{ user: allowed }, { user: denied }]);
  });

  it('fails closed for scoped events without a resolvable session or branch', async () => {
    const allowed = user('allowed');
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const app = makeApp([{ user: allowed }, service]);
    const r = repos({ branch: branch('b1'), users: [allowed], permissions: { allowed: 'view' } });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { task_id: 't1' },
      { path: 'tasks', method: 'create', event: 'created' }
    );

    expect(channel.connections).toEqual([service]);
  });
});
