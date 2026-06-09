import type { Branch, BranchPermissionLevel, Session, User } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type {
  RealtimeAccessBranchRepository,
  RealtimeAccessSessionRepository,
} from './realtime-access-cache';
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

function makeApp(
  connections: unknown[],
  services: Record<string, { get: (id: string) => Promise<unknown> }> = {}
) {
  let publishFn: ((data: unknown, context: any) => unknown) | undefined;
  const app = {
    channel: vi.fn(() => new FakeChannel(connections)),
    publish: vi.fn((fn) => {
      publishFn = fn;
    }),
    service: vi.fn((path: string) => {
      const service = services[path];
      if (!service) throw new Error(`Unexpected service: ${path}`);
      return service;
    }),
    async runPublish(data: unknown, context: any) {
      if (!publishFn) throw new Error('publish not configured');
      return (await publishFn(data, { ...context, app })) as FakeChannel;
    },
  } as any;
  return app;
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
  permissions: Record<string, Branch['others_can']>;
}) {
  const viewableUserIds = Object.entries(options.permissions)
    .filter(([, permission]) =>
      ['view', 'session', 'prompt', 'all'].includes(permission as BranchPermissionLevel)
    )
    .map(([userId]) => userId);
  const branchRepository = {
    findRealtimeVisibilityBranch: vi.fn(async (id: string) =>
      id === options.branch.branch_id ? options.branch : null
    ),
    findExplicitViewUserIds: vi.fn(async () => viewableUserIds),
  } as unknown as RealtimeAccessBranchRepository;
  const sessionsRepository = {
    findBranchIdBySessionId: vi.fn(async (id: string) =>
      options.session?.session_id === id ? options.session.branch_id : null
    ),
  } as unknown as RealtimeAccessSessionRepository;
  return { branchRepository, sessionsRepository };
}

describe('configureRealtimePublish', () => {
  it('preserves legacy authenticated broadcast when branch RBAC is disabled', async () => {
    const app = makeApp([{ user: user('u1') }, { user: user('u2') }]);
    const r = repos({ branch: branch('b1'), permissions: {} });
    configureRealtimePublish({ app, branchRbacEnabled: false, ...r });

    const channel = await app.runPublish(
      { branch_id: 'b1' },
      { path: 'branches', method: 'patch', event: 'patched' }
    );

    expect(channel.connections).toHaveLength(2);
  });

  it('filters branch events to users with view access when RBAC is enabled', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const admin = user('admin', ROLES.SUPERADMIN);
    const app = makeApp([{ user: allowed }, { user: denied }, { user: admin }]);
    const r = repos({
      branch: branch('b1', 'none'),
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { branch_id: 'b1' },
      { path: 'branches', method: 'patch', event: 'patched' }
    );

    expect(channel.connections).toEqual([{ user: allowed }, { user: admin }]);
  });

  it('scopes nested branch permission service events through the route branch id', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const app = makeApp([{ user: allowed }, { user: denied }]);
    const r = repos({
      branch: branch('b1', 'none'),
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { user_id: 'owner-user' },
      {
        path: 'branches/:id/owners',
        method: 'create',
        event: 'created',
        params: { route: { id: 'b1' } },
      }
    );

    expect(channel.connections).toEqual([{ user: allowed }]);
  });

  it('scopes nested branch group grant events through the route branch id', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const app = makeApp([{ user: allowed }, { user: denied }]);
    const r = repos({
      branch: branch('b1', 'none'),
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { group_id: 'g1', can: 'view' },
      {
        path: 'branches/:id/group-grants',
        method: 'create',
        event: 'created',
        params: { route: { id: 'b1' } },
      }
    );

    expect(channel.connections).toEqual([{ user: allowed }]);
  });

  it('broadcasts broadly visible branch events without explicit user expansion', async () => {
    const u1 = user('u1');
    const u2 = user('u2');
    const app = makeApp([{ user: u1 }, { user: u2 }]);
    const r = repos({
      branch: branch('b1', 'session'),
      permissions: {},
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { branch_id: 'b1' },
      { path: 'branches', method: 'patch', event: 'patched' }
    );

    expect(channel.connections).toEqual([{ user: u1 }, { user: u2 }]);
    expect(vi.mocked(r.branchRepository.findExplicitViewUserIds)).not.toHaveBeenCalled();
  });

  it('honors allowSuperadmin=false for branch events', async () => {
    const admin = user('admin', ROLES.SUPERADMIN);
    const app = makeApp([{ user: admin }]);
    const r = repos({
      branch: branch('b1', 'none'),
      permissions: { admin: 'none' },
    });
    configureRealtimePublish({
      app,
      branchRbacEnabled: true,
      allowSuperadmin: false,
      ...r,
    });

    const channel = await app.runPublish(
      { branch_id: 'b1' },
      { path: 'branches', method: 'patch', event: 'patched' }
    );

    expect(channel.connections).toEqual([]);
  });

  it('resolves task/message events through session_id before filtering', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const app = makeApp([{ user: allowed }, { user: denied }, service]);
    const r = repos({
      branch: branch('b1', 'none'),
      session: session('s1', 'b1'),
      permissions: { allowed: 'session', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { task_id: 't1', session_id: 's1' },
      { path: 'tasks', method: 'create', event: 'created' }
    );

    expect(r.sessionsRepository.findBranchIdBySessionId).toHaveBeenCalledWith('s1');
    expect(channel.connections).toEqual([{ user: allowed }, service]);
  });

  it('caches session branch and branch visibility across streaming events', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const app = makeApp([{ user: allowed }, { user: denied }]);
    const r = repos({
      branch: branch('b1', 'none'),
      session: session('s1', 'b1'),
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const first = await app.runPublish(
      { message_id: 'm1', session_id: 's1', chunk: 'a' },
      { path: 'messages', method: 'emit', event: 'streaming:chunk' }
    );
    const second = await app.runPublish(
      { message_id: 'm1', session_id: 's1', chunk: 'b' },
      { path: 'messages', method: 'emit', event: 'streaming:chunk' }
    );

    expect(first.connections).toEqual([{ user: allowed }]);
    expect(second.connections).toEqual([{ user: allowed }]);
    expect(r.sessionsRepository.findBranchIdBySessionId).toHaveBeenCalledTimes(1);
    expect(r.branchRepository.findRealtimeVisibilityBranch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(r.branchRepository.findExplicitViewUserIds)).toHaveBeenCalledTimes(1);
  });

  it('resolves custom sessions events through camelCase sessionId', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const app = makeApp([{ user: allowed }, { user: denied }]);
    const r = repos({
      branch: branch('b1', 'none'),
      session: session('s1', 'b1'),
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { requestId: 'r1', sessionId: 's1' },
      { path: 'sessions', method: 'emit', event: 'permission:request' }
    );

    expect(r.sessionsRepository.findBranchIdBySessionId).toHaveBeenCalledWith('s1');
    expect(channel.connections).toEqual([{ user: allowed }]);
  });

  it('resolves board comment events through session_id when branch_id is absent', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const app = makeApp([{ user: allowed }, { user: denied }]);
    const r = repos({
      branch: branch('b1', 'none'),
      session: session('s1', 'b1'),
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { comment_id: 'c1', session_id: 's1' },
      { path: 'board-comments', method: 'create', event: 'created' }
    );

    expect(r.sessionsRepository.findBranchIdBySessionId).toHaveBeenCalledWith('s1');
    expect(channel.connections).toEqual([{ user: allowed }]);
  });

  it('resolves board comment events through task_id when branch_id is absent', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const app = makeApp([{ user: allowed }, { user: denied }], {
      tasks: { get: vi.fn(async () => ({ session_id: 's1' })) },
    });
    const r = repos({
      branch: branch('b1', 'none'),
      session: session('s1', 'b1'),
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { comment_id: 'c1', task_id: 't1' },
      { path: 'board-comments', method: 'create', event: 'created' }
    );

    expect(app.service('tasks').get).toHaveBeenCalledWith('t1', { provider: undefined });
    expect(channel.connections).toEqual([{ user: allowed }]);
  });

  it('resolves board comment events through message_id when branch_id is absent', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const app = makeApp([{ user: allowed }, { user: denied }], {
      messages: { get: vi.fn(async () => ({ session_id: 's1' })) },
    });
    const r = repos({
      branch: branch('b1', 'none'),
      session: session('s1', 'b1'),
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { comment_id: 'c1', message_id: 'm1' },
      { path: 'board-comments', method: 'create', event: 'created' }
    );

    expect(app.service('messages').get).toHaveBeenCalledWith('m1', { provider: undefined });
    expect(channel.connections).toEqual([{ user: allowed }]);
  });

  it('filters optional branch-scoped events when they carry branch_id', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const app = makeApp([{ user: allowed }, { user: denied }]);
    const r = repos({
      branch: branch('b1', 'none'),
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
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { card_id: 'card1' },
      { path: 'board-objects', method: 'patch', event: 'patched' }
    );

    expect(channel.connections).toEqual([{ user: allowed }, { user: denied }]);
  });

  it('keeps null-branch artifact events scoped to creator/admin/service connections', async () => {
    const creator = user('creator');
    const other = user('other');
    const admin = user('admin', ROLES.ADMIN);
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const app = makeApp([{ user: creator }, { user: other }, { user: admin }, service]);
    const r = repos({
      branch: branch('b1', 'none'),
      permissions: { creator: 'none', other: 'none', admin: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { artifact_id: 'a1', branch_id: null, created_by: 'creator', public: false },
      { path: 'artifacts', method: 'patch', event: 'patched' }
    );

    expect(channel.connections).toEqual([{ user: creator }, { user: admin }, service]);
  });

  it('fails closed for null-branch artifact events without a creator', async () => {
    const allowed = user('allowed');
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const app = makeApp([{ user: allowed }, service]);
    const r = repos({ branch: branch('b1'), permissions: { allowed: 'view' } });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { artifact_id: 'a1', branch_id: null, public: false },
      { path: 'artifacts', method: 'patch', event: 'patched' }
    );

    expect(channel.connections).toEqual([service]);
  });

  it('fails closed for scoped events without a resolvable session or branch', async () => {
    const allowed = user('allowed');
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const tasksGet = vi.fn(async () => ({ session_id: 's1' }));
    const app = makeApp([{ user: allowed }, service], {
      tasks: { get: tasksGet },
    });
    const r = repos({ branch: branch('b1'), permissions: { allowed: 'view' } });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { task_id: 't1' },
      { path: 'tasks', method: 'create', event: 'created' }
    );

    expect(channel.connections).toEqual([service]);
    expect(tasksGet).not.toHaveBeenCalled();
  });
});
