import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Branch, BranchPermissionLevel, Session, User } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type {
  RealtimeAccessBranchRepository,
  RealtimeAccessSessionRepository,
} from './realtime-access-cache';
import { configureRealtimePublish, leaveAllSessionStreamChannels } from './realtime-publish';

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
  services: Record<string, { get: (id: string) => Promise<unknown> }> = {},
  channels: Record<string, unknown[]> = {}
) {
  let publishFn: ((data: unknown, context: any) => unknown) | undefined;
  // Names accessed via the channel factory — mirrors Feathers materializing a
  // channel on lookup, so tests can assert the publish path did NOT create a
  // room.
  const created = new Set<string>();
  const app = {
    // Provided channels plus any materialized by a channel lookup.
    get channels() {
      return [...new Set([...Object.keys(channels), ...created])];
    },
    channel: vi.fn((name: string) => {
      created.add(name);
      return new FakeChannel(channels[name] ?? connections);
    }),
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

const scopeOnlyDb = { run: vi.fn() } as unknown as TenantScopeAwareDatabase;

function repos(options: {
  branch: Branch;
  session?: Session | null;
  permissions: Record<string, Branch['others_can']>;
  /** Owning user id returned by findCreatedByBySessionId (owner-fallback tests). */
  owner?: string | null;
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
    findCreatedByBySessionId: vi.fn(async (id: string) =>
      options.session?.session_id === id ? (options.owner ?? null) : null
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

  it('scopes broadcasts to the resolved tenant channel in static multi-tenancy mode', async () => {
    const tenantUser = user('tenant-user');
    const otherTenantUser = user('other-tenant-user');
    const app = makeApp(
      [{ user: tenantUser }, { user: otherTenantUser }],
      {},
      {
        authenticated: [{ user: tenantUser }, { user: otherTenantUser }],
        'tenant:default': [{ user: tenantUser }],
      }
    );
    const r = repos({ branch: branch('b1'), permissions: {} });
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      multiTenancy: { mode: 'static', static_tenant_id: 'default' as any },
      ...r,
    });

    const channel = await app.runPublish(
      { branch_id: 'b1' },
      { path: 'branches', method: 'patch', event: 'patched', params: {} }
    );

    expect(channel.connections).toEqual([{ user: tenantUser }]);
  });

  it('fails closed for required_from_auth realtime events without tenant context', async () => {
    const member = user('member');
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const app = makeApp([{ user: member }, service]);
    const r = repos({ branch: branch('b1'), permissions: {} });
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as any,
        auth_claim: 'tenant_id',
      },
      ...r,
    });

    const channel = await app.runPublish(
      { branch_id: 'b1' },
      { path: 'branches', method: 'patch', event: 'patched', params: {} }
    );

    expect(channel.connections).toEqual([service]);
  });

  it('routes a manual emit to the tenant channel when the hook context carries params.tenant (regression #1750)', async () => {
    // Background env transitions (health-monitor / executor completion) run
    // outside any request AND outside an ambient tenant DB scope, so the tenant
    // must be resolvable from the emitted hook's params. This is exactly the
    // context shape emitServiceEvent() builds for the branches `patched` emit.
    const tenantUser = user('tenant-user');
    const otherTenantUser = user('other-tenant-user');
    const app = makeApp(
      [{ user: tenantUser }, { user: otherTenantUser }],
      {},
      {
        authenticated: [{ user: tenantUser }, { user: otherTenantUser }],
        'tenant:tenant-a': [{ user: tenantUser }],
        'tenant:tenant-b': [{ user: otherTenantUser }],
      }
    );
    const r = repos({ branch: branch('b1'), permissions: {} });
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as any,
        auth_claim: 'tenant_id',
      },
      ...r,
    });

    // No ambient tenant DB scope here — tenant resolves purely from the hook.
    const channel = await app.runPublish(
      { branch_id: 'b1' },
      {
        path: 'branches',
        method: 'patch',
        event: 'patched',
        id: 'b1',
        params: { tenant: { tenant_id: 'tenant-a', source: 'auth_claim' } },
      }
    );

    expect(channel.connections).toEqual([{ user: tenantUser }]);
  });

  it('re-enters the event tenant scope before branch RBAC visibility lookups', async () => {
    const tenantUser = user('tenant-user');
    const app = makeApp(
      [{ user: tenantUser }],
      {},
      {
        authenticated: [{ user: tenantUser }],
        'tenant:tenant-a': [{ user: tenantUser }],
      }
    );
    const r = repos({ branch: branch('b1', 'view'), permissions: {} });
    vi.mocked(r.branchRepository.findRealtimeVisibilityBranch).mockImplementation(async () => {
      expect(getCurrentTenantId()).toBe('tenant-a');
      return branch('b1', 'view');
    });
    configureRealtimePublish({
      app,
      db: scopeOnlyDb,
      branchRbacEnabled: true,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as any,
        auth_claim: 'tenant_id',
      },
      ...r,
    });

    const channel = await app.runPublish(
      { branch_id: 'b1', environment_instance: { status: 'running' } },
      {
        path: 'branches',
        method: 'patch',
        event: 'patched',
        id: 'b1',
        params: { tenant: { tenant_id: 'tenant-a', source: 'auth_claim' } },
      }
    );

    expect(channel.connections).toEqual([{ user: tenantUser }]);
  });

  it('uses ambient tenant database scope for internal/manual emits without params tenant', async () => {
    const tenantUser = user('tenant-user');
    const otherTenantUser = user('other-tenant-user');
    const app = makeApp(
      [{ user: tenantUser }, { user: otherTenantUser }],
      {},
      {
        authenticated: [{ user: tenantUser }, { user: otherTenantUser }],
        'tenant:tenant-a': [{ user: tenantUser }],
        'tenant:tenant-b': [{ user: otherTenantUser }],
      }
    );
    const r = repos({ branch: branch('b1'), permissions: {} });
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as any,
        auth_claim: 'tenant_id',
      },
      ...r,
    });

    const channel = await runWithTenantDatabaseScope(scopeOnlyDb, 'tenant-a', async () =>
      app.runPublish(
        { branch_id: 'b1' },
        { path: 'branches', method: 'patch', event: 'patched', params: {} }
      )
    );

    expect(channel.connections).toEqual([{ user: tenantUser }]);
  });

  it('uses authenticated socket connection tenant for executor/service emits without params tenant', async () => {
    const tenantUser = user('tenant-user');
    const otherTenantUser = user('other-tenant-user');
    const app = makeApp(
      [{ user: tenantUser }, { user: otherTenantUser }],
      {},
      {
        authenticated: [{ user: tenantUser }, { user: otherTenantUser }],
        'tenant:tenant-a': [{ user: tenantUser }],
        'tenant:tenant-b': [{ user: otherTenantUser }],
      }
    );
    const r = repos({ branch: branch('b1'), permissions: {} });
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as any,
        auth_claim: 'tenant_id',
      },
      ...r,
    });

    const channel = await app.runPublish(
      { branch_id: 'b1' },
      {
        path: 'branches',
        method: 'patch',
        event: 'patched',
        params: {
          connection: {
            tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
          },
        },
      }
    );

    expect(channel.connections).toEqual([{ user: tenantUser }]);
  });

  it('uses authenticated socket data tenant for executor/service emits without params tenant', async () => {
    const tenantUser = user('tenant-user');
    const otherTenantUser = user('other-tenant-user');
    const app = makeApp(
      [{ user: tenantUser }, { user: otherTenantUser }],
      {},
      {
        authenticated: [{ user: tenantUser }, { user: otherTenantUser }],
        'tenant:tenant-a': [{ user: tenantUser }],
        'tenant:tenant-b': [{ user: otherTenantUser }],
      }
    );
    const r = repos({ branch: branch('b1'), permissions: {} });
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as any,
        auth_claim: 'tenant_id',
      },
      ...r,
    });

    const channel = await app.runPublish(
      { branch_id: 'b1' },
      {
        path: 'branches',
        method: 'patch',
        event: 'patched',
        params: {
          connection: {
            data: { tenant: { tenant_id: 'tenant-a', source: 'auth_claim' } },
          },
        },
      }
    );

    expect(channel.connections).toEqual([{ user: tenantUser }]);
  });

  it('does not trust event payload tenant_id without auth or ambient tenant scope', async () => {
    const member = user('member');
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const app = makeApp(
      [{ user: member }, service],
      {},
      {
        authenticated: [{ user: member }, service],
        'tenant:tenant-a': [{ user: member }],
      }
    );
    const r = repos({ branch: branch('b1'), permissions: {} });
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as any,
        auth_claim: 'tenant_id',
      },
      ...r,
    });

    const channel = await app.runPublish(
      { branch_id: 'b1', tenant_id: 'tenant-a' },
      { path: 'branches', method: 'patch', event: 'patched', params: {} }
    );

    expect(channel.connections).toEqual([service]);
    expect(app.channel).not.toHaveBeenCalledWith('tenant:tenant-a');
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

  it('delivers an archived branch tombstone only to tenant users who had view access', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const otherTenant = user('other-tenant');
    const allowedConnection = { user: allowed };
    const deniedConnection = { user: denied };
    const app = makeApp(
      [allowedConnection, deniedConnection, { user: otherTenant }],
      {},
      {
        authenticated: [allowedConnection, deniedConnection, { user: otherTenant }],
        'tenant:tenant-a': [allowedConnection, deniedConnection],
      }
    );
    const archivedBranch = { ...branch('b1', 'none'), archived: true } as Branch;
    const r = repos({
      branch: archivedBranch,
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({
      app,
      db: scopeOnlyDb,
      branchRbacEnabled: true,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as any,
        auth_claim: 'tenant_id',
      },
      ...r,
    });

    const channel = await app.runPublish(archivedBranch, {
      path: 'branches',
      method: 'patch',
      event: 'patched',
      id: 'b1',
      params: { tenant: { tenant_id: 'tenant-a', source: 'auth_claim' } },
    });

    expect(channel.connections).toEqual([allowedConnection]);
    expect(r.branchRepository.findRealtimeVisibilityBranch).toHaveBeenCalledWith('b1');
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

  it('caches the session owner lookup across repeated streaming chunks', async () => {
    // Streaming chunks are no longer branch-scoped — they route to the session
    // room plus the owner fallback — so the per-chunk work is the owner lookup,
    // which must be cached rather than hitting the DB on every chunk.
    const owner = { user: user('owner-user') };
    const other = { user: user('other') };
    const app = makeApp(
      [owner, other],
      {},
      {
        authenticated: [owner, other],
        'session-stream:s1': [],
      }
    );
    const r = repos({
      branch: branch('b1', 'view'),
      session: session('s1', 'b1'),
      permissions: {},
      owner: 'owner-user',
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const first = await app.runPublish(
      { message_id: 'm1', session_id: 's1', chunk: 'a' },
      { path: 'messages', method: 'emit', event: 'streaming:chunk', params: {} }
    );
    const second = await app.runPublish(
      { message_id: 'm1', session_id: 's1', chunk: 'b' },
      { path: 'messages', method: 'emit', event: 'streaming:chunk', params: {} }
    );

    expect(unionConnections(first)).toEqual([owner]);
    expect(unionConnections(second)).toEqual([owner]);
    expect(r.sessionsRepository.findCreatedByBySessionId).toHaveBeenCalledTimes(1);
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

  it('resolves link events through session_id when branch_id is absent', async () => {
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
      { link_id: 'l1', session_id: 's1' },
      { path: 'links', method: 'create', event: 'created' }
    );

    expect(r.sessionsRepository.findBranchIdBySessionId).toHaveBeenCalledWith('s1');
    expect(channel.connections).toEqual([{ user: allowed }]);
  });

  it('keeps internal link events on trusted service connections', async () => {
    const viewer = { user: user('viewer') };
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const app = makeApp([viewer, service]);
    const r = repos({ branch: branch('b1', 'view'), permissions: {} });
    configureRealtimePublish({ app, branchRbacEnabled: false, ...r });

    const channel = await app.runPublish(
      { link_id: 'l1', session_id: 's1', kind: 'internal' },
      { path: 'links', method: 'create', event: 'created' }
    );
    const publicChannel = await app.runPublish(
      {
        link_id: 'l2',
        session_id: 's1',
        kind: 'url',
        target_object_type: null,
        target_object_id: null,
      },
      { path: 'links', method: 'create', event: 'created' }
    );

    expect(channel.connections).toEqual([service]);
    expect(publicChannel.connections).toEqual([viewer, service]);
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

/**
 * Streaming events (per-chunk message/thinking deltas and task tool events) are
 * routed to the per-session stream room, service connections, and the session
 * owner's connections — never the whole tenant. The publish handler returns an
 * array of channels for these; Feathers unions them, so tests collapse the
 * array to a unique connection set.
 */
function unionConnections(result: unknown): unknown[] {
  const channels = Array.isArray(result) ? result : [result];
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  for (const channel of channels) {
    for (const connection of (channel as FakeChannel).connections) {
      if (!seen.has(connection)) {
        seen.add(connection);
        out.push(connection);
      }
    }
  }
  return out;
}

describe('configureRealtimePublish streaming scope', () => {
  const streamingContext = {
    path: 'messages',
    method: 'create',
    event: 'streaming:chunk',
    params: {},
  };

  it('delivers a streaming chunk to subscribed connections, not other authenticated tabs', async () => {
    const viewer = { user: user('viewer') };
    const subscribed = { user: user('subscribed') };
    const app = makeApp(
      [viewer, subscribed],
      {},
      {
        authenticated: [viewer, subscribed],
        'session-stream:s1': [subscribed],
      }
    );
    const r = repos({
      branch: branch('b1', 'view'),
      session: session('s1', 'b1'),
      permissions: {},
    });
    configureRealtimePublish({ app, branchRbacEnabled: false, ...r });

    const result = await app.runPublish(
      { session_id: 's1', message_id: 'm1', chunk: 'hello' },
      streamingContext
    );

    expect(unionConnections(result)).toEqual([subscribed]);
  });

  it('still delivers streaming chunks to service-account connections (gateway/Slack)', async () => {
    const viewer = { user: user('viewer') };
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const app = makeApp(
      [viewer, service],
      {},
      {
        authenticated: [viewer, service],
        'session-stream:s1': [],
      }
    );
    const r = repos({
      branch: branch('b1', 'view'),
      session: session('s1', 'b1'),
      permissions: {},
    });
    configureRealtimePublish({ app, branchRbacEnabled: false, ...r });

    const result = await app.runPublish(
      { session_id: 's1', message_id: 'm1', chunk: 'hi' },
      streamingContext
    );

    expect(unionConnections(result)).toEqual([service]);
  });

  it('delivers to the session owner as a fallback even when they have not subscribed', async () => {
    const owner = { user: user('owner-user') };
    const other = { user: user('other-user') };
    const app = makeApp(
      [owner, other],
      {},
      {
        authenticated: [owner, other],
        'session-stream:s1': [],
      }
    );
    const r = repos({
      branch: branch('b1', 'view'),
      session: session('s1', 'b1'),
      permissions: {},
      owner: 'owner-user',
    });
    configureRealtimePublish({ app, branchRbacEnabled: false, ...r });

    const result = await app.runPublish(
      { session_id: 's1', message_id: 'm1', chunk: 'hi' },
      streamingContext
    );

    expect(unionConnections(result)).toEqual([owner]);
  });

  it('routes tasks tool:start events through the same session scoping', async () => {
    const subscribed = { user: user('subscribed') };
    const other = { user: user('other') };
    const app = makeApp(
      [subscribed, other],
      {},
      {
        authenticated: [subscribed, other],
        'session-stream:s1': [subscribed],
      }
    );
    const r = repos({
      branch: branch('b1', 'view'),
      session: session('s1', 'b1'),
      permissions: {},
    });
    configureRealtimePublish({ app, branchRbacEnabled: false, ...r });

    const result = await app.runPublish(
      { session_id: 's1', task_id: 't1', tool_use_id: 'x', tool_name: 'Bash' },
      { path: 'tasks', method: 'create', event: 'tool:start', params: {} }
    );

    expect(unionConnections(result)).toEqual([subscribed]);
  });

  it('fails closed to service connections when a streaming event carries no session id', async () => {
    const viewer = { user: user('viewer') };
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const app = makeApp(
      [viewer, service],
      {},
      {
        authenticated: [viewer, service],
      }
    );
    const r = repos({ branch: branch('b1', 'view'), permissions: {} });
    configureRealtimePublish({ app, branchRbacEnabled: false, ...r });

    const result = await app.runPublish({ message_id: 'm1', chunk: 'orphan' }, streamingContext);

    expect(unionConnections(result)).toEqual([service]);
  });

  it('scopes streaming even when branch RBAC is enabled', async () => {
    const subscribed = { user: user('subscribed') };
    const other = { user: user('other') };
    const app = makeApp(
      [subscribed, other],
      {},
      {
        authenticated: [subscribed, other],
        'session-stream:s1': [subscribed],
      }
    );
    const r = repos({
      branch: branch('b1', 'view'),
      session: session('s1', 'b1'),
      permissions: { subscribed: 'view', other: 'view' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const result = await app.runPublish(
      { session_id: 's1', message_id: 'm1', chunk: 'hello' },
      streamingContext
    );

    expect(unionConnections(result)).toEqual([subscribed]);
  });

  it('drops a subscribed connection whose branch access was revoked (RBAC on)', async () => {
    // Both are in the room, but only `allowed` currently holds view on the
    // explicit-users branch. Publish-time filtering must exclude `revoked`
    // rather than trust its stale room membership.
    const allowed = { user: user('allowed') };
    const revoked = { user: user('revoked') };
    const app = makeApp(
      [allowed, revoked],
      {},
      {
        authenticated: [allowed, revoked],
        'session-stream:s1': [allowed, revoked],
      }
    );
    const r = repos({
      branch: branch('b1', 'none'),
      session: session('s1', 'b1'),
      permissions: { allowed: 'view' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const result = await app.runPublish(
      { session_id: 's1', message_id: 'm1', chunk: 'hello' },
      streamingContext
    );

    expect(unionConnections(result)).toEqual([allowed]);
  });

  it('drops the owner fallback when the owner lost branch access (RBAC on)', async () => {
    // Nobody is subscribed; the owner is the only candidate, but their view was
    // revoked, so the owner-fallback must NOT deliver.
    const owner = { user: user('owner-user') };
    const viewer = { user: user('viewer') };
    const app = makeApp(
      [owner, viewer],
      {},
      {
        authenticated: [owner, viewer],
        'session-stream:s1': [],
      }
    );
    const r = repos({
      branch: branch('b1', 'none'),
      session: session('s1', 'b1'),
      permissions: { viewer: 'view' },
      owner: 'owner-user',
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const result = await app.runPublish(
      { session_id: 's1', message_id: 'm1', chunk: 'hello' },
      streamingContext
    );

    expect(unionConnections(result)).toEqual([]);
  });

  it('delivers to the owner fallback while they retain branch access (RBAC on)', async () => {
    const owner = { user: user('owner-user') };
    const other = { user: user('other') };
    const app = makeApp(
      [owner, other],
      {},
      {
        authenticated: [owner, other],
        'session-stream:s1': [],
      }
    );
    const r = repos({
      branch: branch('b1', 'none'),
      session: session('s1', 'b1'),
      permissions: { 'owner-user': 'view' },
      owner: 'owner-user',
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const result = await app.runPublish(
      { session_id: 's1', message_id: 'm1', chunk: 'hello' },
      streamingContext
    );

    expect(unionConnections(result)).toEqual([owner]);
  });

  it('does not materialize a room for a session with no subscribers', async () => {
    // No `session-stream:s1` channel provided → the session has no subscribers.
    const viewer = { user: user('viewer') };
    const app = makeApp([viewer], {}, { authenticated: [viewer] });
    const r = repos({
      branch: branch('b1', 'view'),
      session: session('s1', 'b1'),
      permissions: {},
    });
    configureRealtimePublish({ app, branchRbacEnabled: false, ...r });

    await app.runPublish({ session_id: 's1', message_id: 'm1', chunk: 'hello' }, streamingContext);

    // The publish path must not have created the empty room.
    expect(app.channels).not.toContain('session-stream:s1');
  });

  it('delivers to a subscribed session whose room already exists', async () => {
    const subscribed = { user: user('subscribed') };
    const app = makeApp(
      [subscribed],
      {},
      {
        authenticated: [subscribed],
        'session-stream:s1': [subscribed],
      }
    );
    const r = repos({
      branch: branch('b1', 'view'),
      session: session('s1', 'b1'),
      permissions: {},
    });
    configureRealtimePublish({ app, branchRbacEnabled: false, ...r });

    const result = await app.runPublish(
      { session_id: 's1', message_id: 'm1', chunk: 'hello' },
      streamingContext
    );

    expect(app.channels).toContain('session-stream:s1');
    expect(unionConnections(result)).toEqual([subscribed]);
  });

  it('does not resurrect the room after the last subscriber has left', async () => {
    // The room was pruned when its last subscriber left, so it is absent again.
    const viewer = { user: user('viewer') };
    const app = makeApp([viewer], {}, { authenticated: [viewer] });
    const r = repos({
      branch: branch('b1', 'view'),
      session: session('s1', 'b1'),
      permissions: {},
    });
    configureRealtimePublish({ app, branchRbacEnabled: false, ...r });

    await app.runPublish({ session_id: 's1', message_id: 'm1', chunk: 'a' }, streamingContext);
    await app.runPublish({ session_id: 's1', message_id: 'm1', chunk: 'b' }, streamingContext);

    expect(app.channels).not.toContain('session-stream:s1');
  });

  it('excludes a room member no longer in the tenant/auth channel (logout fail-open guard, RBAC off)', async () => {
    // `loggedOut` still sits in the session-stream room (Feathers only drops
    // room membership on socket disconnect) but has been removed from the
    // authenticated channel. Intersecting the room with tenantScoped must keep
    // streaming from reaching it — this is the RBAC-off path that would
    // otherwise return the room unfiltered.
    const active = { user: user('active') };
    const loggedOut = { user: user('gone') };
    const app = makeApp(
      [active],
      {},
      {
        authenticated: [active],
        'session-stream:s1': [active, loggedOut],
      }
    );
    const r = repos({
      branch: branch('b1', 'view'),
      session: session('s1', 'b1'),
      permissions: {},
    });
    configureRealtimePublish({ app, branchRbacEnabled: false, ...r });

    const result = await app.runPublish(
      { session_id: 's1', message_id: 'm1', chunk: 'hello' },
      streamingContext
    );

    expect(unionConnections(result)).toEqual([active]);
  });
});

describe('leaveAllSessionStreamChannels', () => {
  it('leaves only session-stream rooms for the connection', () => {
    const leaves: Array<[string, unknown]> = [];
    const app = {
      channels: ['authenticated', 'tenant:default', 'session-stream:s1', 'session-stream:s2'],
      channel: (name: string) => ({
        leave: (connection: unknown) => {
          leaves.push([name, connection]);
        },
      }),
    } as unknown as Parameters<typeof leaveAllSessionStreamChannels>[0];
    const connection = { id: 'c1' };

    leaveAllSessionStreamChannels(app, connection);

    expect(leaves).toEqual([
      ['session-stream:s1', connection],
      ['session-stream:s2', connection],
    ]);
  });
});
