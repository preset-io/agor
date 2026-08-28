import {
  type BoardRepository,
  type Database,
  generateId,
  getCurrentTenantId,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { REALTIME_RELAY_VERSION } from '@agor/core/realtime';
import type { Branch, BranchPermissionLevel, Session, User, UserID } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { sessionStreamRoomName, tenantChannelName } from '../realtime/routing';
import { KNOWLEDGE_REALTIME_SUPPRESSED_CREATE_PATHS } from './knowledge-realtime-publish';
import type {
  RealtimeAccessBranchRepository,
  RealtimeAccessSessionRepository,
} from './realtime-access-cache';
import {
  configureRealtimePublish,
  executorTaskChannelName,
  markConnectionSessionStreamsAware,
  REDIS_FEATHERS_DENIED_PATHS,
  setBoardRemovalRealtimeVisibility,
  setBranchRemovalRealtimeVisibility,
} from './realtime-publish';
import { isRealtimePublishAllowed, realtimePublishPolicyFor } from './realtime-publish-policy';

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
  const normalizeFixtureChannelName = (name: string): string => {
    const tenantMatch = /^tenant:([^:]+)$/.exec(name);
    if (tenantMatch?.[1]) return tenantChannelName(tenantMatch[1]);
    if (name.startsWith('session-stream:')) {
      return sessionStreamRoomName('standalone', name.slice('session-stream:'.length));
    }
    return name;
  };
  const normalizedChannels = Object.fromEntries(
    Object.entries(channels).map(([name, value]) => [normalizeFixtureChannelName(name), value])
  );
  let publishFn: ((data: unknown, context: any) => unknown) | undefined;
  // Names accessed via the channel factory — mirrors Feathers materializing a
  // channel on lookup, so tests can assert the publish path did NOT create a
  // room.
  const created = new Set<string>();
  const app = {
    // Provided channels plus any materialized by a channel lookup.
    get channels() {
      return [...new Set([...Object.keys(normalizedChannels), ...created])];
    },
    channel: vi.fn((name: string) => {
      created.add(name);
      return new FakeChannel(normalizedChannels[name] ?? connections);
    }),
    publish: vi.fn((fn) => {
      publishFn = fn;
    }),
    emit: vi.fn(),
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

describe('configureRealtimePublish executor control scope', () => {
  it('routes termination only to the private room for that Task', async () => {
    const browser = { user: user('browser') };
    const executor = { user: user('executor') };
    const room = executorTaskChannelName('tenant-a', 'task-1');
    const app = makeApp([browser, executor], {}, { [room]: [executor] });
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      branchRepository: {} as never,
      sessionsRepository: {} as never,
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
    });

    const result = (await app.runPublish(
      { task_id: 'task-1', status: 'stopping' },
      {
        path: 'tasks',
        method: 'patch',
        event: 'termination_requested',
        params: {},
      }
    )) as unknown as FakeChannel[];

    expect(result).toHaveLength(1);
    expect(result[0]?.connections).toEqual([executor]);
  });

  it('routes a standalone permission decision only to the private room for that Task', async () => {
    const browser = { user: user('browser') };
    const executor = { user: user('executor') };
    const room = executorTaskChannelName('tenant-a', 'task-1');
    const app = makeApp([browser, executor], {}, { [room]: [executor] });
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      branchRepository: {} as never,
      sessionsRepository: {} as never,
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
    });

    const result = (await app.runPublish(
      { requestId: 'request-1', taskId: 'task-1', allow: true },
      {
        path: 'messages',
        method: 'patch',
        event: 'permission_resolved',
        params: {},
      }
    )) as unknown as FakeChannel[];

    expect(result).toHaveLength(1);
    expect(result[0]?.connections).toEqual([executor]);
    expect(result[0]?.connections).not.toContain(browser);
  });

  it('does not materialize a room when Stop wins before executor connect', async () => {
    const app = makeApp([]);
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      branchRepository: {} as never,
      sessionsRepository: {} as never,
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
    });

    await expect(
      app.runPublish(
        { task_id: 'task-1', status: 'stopping' },
        {
          path: 'tasks',
          method: 'patch',
          event: 'termination_requested',
          params: {},
        }
      )
    ).resolves.toEqual([]);
    expect(app.channels).not.toContain(executorTaskChannelName('tenant-a', 'task-1'));
  });

  it('does not deliver a tenant A Stop to the same Task room in tenant B', async () => {
    const tenantBExecutor = { user: user('executor-b') };
    const tenantBRoom = executorTaskChannelName('tenant-b', 'task-1');
    const app = makeApp([tenantBExecutor], {}, { [tenantBRoom]: [tenantBExecutor] });
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      branchRepository: {} as never,
      sessionsRepository: {} as never,
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
    });

    await expect(
      app.runPublish(
        { task_id: 'task-1', status: 'stopping' },
        {
          path: 'tasks',
          method: 'patch',
          event: 'termination_requested',
          params: {},
        }
      )
    ).resolves.toEqual([]);
  });
});

describe('HA Feathers publication relay', () => {
  it('bridges executor control to the receiving replica local Feathers room only', async () => {
    const executorA = { user: user('executor-a') };
    const executorB = { user: user('executor-b') };
    let remoteHandler: ((envelope: any) => Promise<void> | void) | undefined;
    const relay = {
      relay: vi.fn(),
      setRelayHandler: vi.fn((handler) => {
        remoteHandler = handler;
      }),
    };
    const app = makeApp(
      [],
      {},
      {
        [executorTaskChannelName('tenant-a', 'task-1')]: [executorA],
        [executorTaskChannelName('tenant-b', 'task-1')]: [executorB],
      }
    );
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      branchRepository: {} as never,
      sessionsRepository: {} as never,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'unused' as never,
        auth_claim: 'tenant_id',
      },
      realtimeRelay: relay,
    });

    await remoteHandler?.({
      version: REALTIME_RELAY_VERSION,
      tenantId: 'tenant-a',
      path: 'tasks',
      event: 'termination_requested',
      method: 'patch',
      id: 'task-1',
      data: { task_id: 'task-1', status: 'stopping' },
    });

    expect(app.emit).toHaveBeenCalledOnce();
    const channel = app.emit.mock.calls[0]?.[2] as FakeChannel;
    expect(channel.connections).toEqual([executorA]);
    expect(channel.connections).not.toContain(executorB);
  });

  it('bridges permission delivery across replicas without crossing tenant Task rooms', async () => {
    const executorA = { user: user('executor-a') };
    const executorB = { user: user('executor-b') };
    let remoteHandler: ((envelope: any) => Promise<void> | void) | undefined;
    const relay = {
      relay: vi.fn(),
      setRelayHandler: vi.fn((handler) => {
        remoteHandler = handler;
      }),
    };
    const app = makeApp(
      [],
      {},
      {
        [executorTaskChannelName('tenant-a', 'task-1')]: [executorA],
        [executorTaskChannelName('tenant-b', 'task-1')]: [executorB],
      }
    );
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      branchRepository: {} as never,
      sessionsRepository: {} as never,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'unused' as never,
        auth_claim: 'tenant_id',
      },
      realtimeRelay: relay,
    });

    await remoteHandler?.({
      version: REALTIME_RELAY_VERSION,
      tenantId: 'tenant-a',
      path: 'messages',
      event: 'permission_resolved',
      method: 'patch',
      id: 'message-1',
      data: { requestId: 'request-1', taskId: 'task-1', allow: true },
    });

    expect(app.emit).toHaveBeenCalledOnce();
    const channel = app.emit.mock.calls[0]?.[2] as FakeChannel;
    expect(channel.connections).toEqual([executorA]);
    expect(channel.connections).not.toContain(executorB);
  });

  it('re-runs tenant containment on the receiving replica', async () => {
    const tenantAUser = { user: user('tenant-a-user') };
    const tenantBUser = { user: user('tenant-b-user') };
    let remoteHandler: ((envelope: any) => Promise<void> | void) | undefined;
    const relay = {
      relay: vi.fn(),
      setRelayHandler: vi.fn((handler) => {
        remoteHandler = handler;
      }),
    };
    const app = makeApp(
      [tenantAUser, tenantBUser],
      {},
      {
        'tenant:tenant-a': [tenantAUser],
        'tenant:tenant-b': [tenantBUser],
      }
    );
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      branchRepository: {} as never,
      sessionsRepository: {} as never,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'unused' as never,
        auth_claim: 'tenant_id',
      },
      realtimeRelay: relay,
    });

    await remoteHandler?.({
      version: REALTIME_RELAY_VERSION,
      tenantId: 'tenant-a',
      path: 'boards',
      event: 'patched',
      method: 'patch',
      id: 'board-a',
      data: { board_id: 'board-a', tenant_id: 'tenant-a' },
    });

    expect(app.emit).toHaveBeenCalledOnce();
    const channel = app.emit.mock.calls[0]?.[2] as FakeChannel;
    expect(channel.connections).toEqual([tenantAUser]);
    expect(channel.connections).not.toContain(tenantBUser);
  });

  it('re-resolves board authority instead of trusting a relayed shared payload', async () => {
    const allowed = { user: user('allowed') };
    const denied = { user: user('denied') };
    const otherTenant = { user: user('other-tenant') };
    let remoteHandler: ((envelope: any) => Promise<void> | void) | undefined;
    const relay = {
      relay: vi.fn(),
      setRelayHandler: vi.fn((handler) => {
        remoteHandler = handler;
      }),
    };
    const app = makeApp(
      [allowed, denied, otherTenant],
      {},
      {
        'tenant:tenant-a': [allowed, denied],
        'tenant:tenant-b': [otherTenant],
      }
    );
    const currentBoard = vi.fn(async () => ({
      board_id: 'board-a',
      access_mode: 'private' as const,
    }));
    const findRealtimeViewUserIds = vi.fn(async () => ['allowed']);
    configureRealtimePublish({
      app,
      branchRbacEnabled: true,
      ...repos({ branch: branch('unused'), permissions: {} }),
      boardRepository: {
        findById: currentBoard,
        findRealtimeViewUserIds,
      } as unknown as BoardRepository,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'unused' as never,
        auth_claim: 'tenant_id',
      },
      realtimeRelay: relay,
    });

    const forgedSharedEnvelope = {
      version: REALTIME_RELAY_VERSION,
      tenantId: 'tenant-a',
      path: 'boards',
      event: 'patched',
      method: 'patch',
      id: 'board-a',
      data: { board_id: 'board-a', access_mode: 'shared' },
    };
    await remoteHandler?.(forgedSharedEnvelope);

    expect(currentBoard).toHaveBeenCalledWith('board-a');
    expect(findRealtimeViewUserIds).toHaveBeenCalledOnce();
    expect(findRealtimeViewUserIds).toHaveBeenCalledWith('board-a');
    expect(app.emit).toHaveBeenCalledOnce();
    const currentPrivateDelivery = app.emit.mock.calls[0]?.[2] as FakeChannel;
    expect(currentPrivateDelivery.connections).toEqual([allowed]);
    expect(currentPrivateDelivery.connections).not.toContain(denied);
    expect(currentPrivateDelivery.connections).not.toContain(otherTenant);

    // Once the current row is gone, the same payload carries no authority.
    // Only a server-captured boardRemovalVisibility snapshot can publish a
    // deleted board tombstone.
    app.emit.mockClear();
    currentBoard.mockResolvedValueOnce(null as never);
    await remoteHandler?.(forgedSharedEnvelope);
    expect(app.emit).not.toHaveBeenCalled();
  });

  it('re-applies service role floors on the receiving replica', async () => {
    const viewer = { user: user('viewer', ROLES.VIEWER) };
    const member = { user: user('member', ROLES.MEMBER) };
    const admin = { user: user('admin', ROLES.ADMIN) };
    let remoteHandler: ((envelope: any) => Promise<void> | void) | undefined;
    const relay = {
      relay: vi.fn(),
      setRelayHandler: vi.fn((handler) => {
        remoteHandler = handler;
      }),
    };
    const app = makeApp(
      [viewer, member, admin],
      {},
      { 'tenant:tenant-a': [viewer, member, admin] }
    );
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      branchRepository: {} as never,
      sessionsRepository: {} as never,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'unused' as never,
        auth_claim: 'tenant_id',
      },
      realtimeRelay: relay,
    });

    await remoteHandler?.({
      version: REALTIME_RELAY_VERSION,
      tenantId: 'tenant-a',
      path: 'users',
      event: 'patched',
      method: 'patch',
      id: 'changed-user',
      data: { user_id: 'changed-user', role: ROLES.MEMBER },
    });

    expect(app.emit).toHaveBeenCalledOnce();
    const channel = app.emit.mock.calls[0]?.[2] as FakeChannel;
    expect(channel.connections).toEqual([member, admin]);
    expect(channel.connections).not.toContain(viewer);
  });

  it('relays a branch tombstone snapshot and re-applies tenant/RBAC containment on the receiving replica', async () => {
    const allowed = { user: user('allowed') };
    const denied = { user: user('denied') };
    const otherTenant = { user: user('other-tenant') };
    let remoteHandler: ((envelope: any) => Promise<void> | void) | undefined;
    const relay = {
      relay: vi.fn(),
      setRelayHandler: vi.fn((handler) => {
        remoteHandler = handler;
      }),
    };
    const app = makeApp(
      [allowed, denied, otherTenant],
      {},
      {
        'tenant:tenant-a': [allowed, denied],
        'tenant:tenant-b': [otherTenant],
      }
    );
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(async () => null),
      findRealtimeViewUserIds: vi.fn(async () => []),
    } as unknown as RealtimeAccessBranchRepository;
    const params = {
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
    } as any;
    setBranchRemovalRealtimeVisibility(params, 'b1' as never, {
      mode: 'explicitUsers',
      userIds: new Set(['allowed' as UserID]),
    });
    configureRealtimePublish({
      app,
      branchRbacEnabled: true,
      branchRepository,
      sessionsRepository: {
        findBranchIdBySessionId: vi.fn(async () => null),
        findCreatedByBySessionId: vi.fn(async () => null),
      } as unknown as RealtimeAccessSessionRepository,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'unused' as never,
        auth_claim: 'tenant_id',
      },
      realtimeRelay: relay,
    });

    const local = await app.runPublish(branch('b1', 'none'), {
      path: 'branches',
      event: 'removed',
      method: 'remove',
      id: 'b1',
      params,
    });

    expect(local.connections).toEqual([allowed]);
    expect(relay.relay).toHaveBeenCalledOnce();
    const envelope = relay.relay.mock.calls[0]?.[0];
    expect(envelope).toMatchObject({
      version: REALTIME_RELAY_VERSION,
      tenantId: 'tenant-a',
      path: 'branches',
      event: 'removed',
      branchRemovalVisibility: {
        branchId: 'b1',
        mode: 'explicitUsers',
        userIds: ['allowed'],
      },
    });

    app.emit.mockClear();
    await remoteHandler?.(envelope);

    expect(app.emit).toHaveBeenCalledOnce();
    const remote = app.emit.mock.calls[0]?.[2] as FakeChannel;
    expect(remote.connections).toEqual([allowed]);
    expect(remote.connections).not.toContain(denied);
    expect(remote.connections).not.toContain(otherTenant);
    expect(branchRepository.findRealtimeVisibilityBranch).not.toHaveBeenCalled();
  });

  it('relays a private-board tombstone only to its pre-delete viewers', async () => {
    const allowed = { user: user('allowed') };
    const denied = { user: user('denied') };
    const otherTenant = { user: user('other-tenant') };
    let remoteHandler: ((envelope: any) => Promise<void> | void) | undefined;
    const relay = {
      relay: vi.fn(),
      setRelayHandler: vi.fn((handler) => {
        remoteHandler = handler;
      }),
    };
    const app = makeApp(
      [allowed, denied, otherTenant],
      {},
      {
        'tenant:tenant-a': [allowed, denied],
        'tenant:tenant-b': [otherTenant],
      }
    );
    const r = repos({ branch: branch('b1'), permissions: {} });
    const params = { tenant: { tenant_id: 'tenant-a', source: 'auth_claim' } } as any;
    setBoardRemovalRealtimeVisibility(params, 'board-a' as never, {
      mode: 'explicitUsers',
      userIds: new Set(['allowed' as UserID]),
    });
    configureRealtimePublish({
      app,
      branchRbacEnabled: true,
      ...r,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'unused' as never,
        auth_claim: 'tenant_id',
      },
      realtimeRelay: relay,
    });

    const local = await app.runPublish(
      { board_id: 'board-a', access_mode: 'private', created_by: 'allowed' },
      { path: 'boards', event: 'removed', method: 'remove', id: 'board-a', params }
    );
    expect(local.connections).toEqual([allowed]);
    const envelope = relay.relay.mock.calls[0]?.[0];
    expect(envelope).toMatchObject({
      version: REALTIME_RELAY_VERSION,
      tenantId: 'tenant-a',
      boardRemovalVisibility: {
        boardId: 'board-a',
        mode: 'explicitUsers',
        userIds: ['allowed'],
      },
    });

    app.emit.mockClear();
    await remoteHandler?.(envelope);
    const remote = app.emit.mock.calls[0]?.[2] as FakeChannel;
    expect(remote.connections).toEqual([allowed]);
    expect(remote.connections).not.toContain(denied);
    expect(remote.connections).not.toContain(otherTenant);
  });

  it('never places authentication results on the shared relay', async () => {
    const app = makeApp(
      [{ user: user('u1') }],
      {},
      {
        'tenant:tenant-a': [{ user: user('u1') }],
      }
    );
    const relay = { relay: vi.fn(), setRelayHandler: vi.fn() };
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      branchRepository: {} as never,
      sessionsRepository: {} as never,
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
      realtimeRelay: relay,
    });

    await app.runPublish(
      { accessToken: 'must-not-leave-process' },
      { path: 'authentication', event: 'created', method: 'create', params: {} }
    );
    expect(relay.relay).not.toHaveBeenCalled();
  });

  it('relays the Feathers dispatch projection rather than an unredacted result', async () => {
    const tenantUser = { user: user('u1') };
    const app = makeApp([tenantUser], {}, { 'tenant:tenant-a': [tenantUser] });
    const relay = { relay: vi.fn(), setRelayHandler: vi.fn() };
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      branchRepository: {} as never,
      sessionsRepository: {} as never,
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
      realtimeRelay: relay,
    });

    await app.runPublish(
      { id: 'channel-1', bot_token: 'must-not-enter-redis' },
      {
        path: 'gateway-channels',
        event: 'patched',
        method: 'patch',
        params: {},
        dispatch: { id: 'channel-1', bot_token: '[REDACTED]' },
      }
    );

    expect(relay.relay).toHaveBeenCalledWith(
      expect.objectContaining({ data: { id: 'channel-1', bot_token: '[REDACTED]' } })
    );
    expect(JSON.stringify(relay.relay.mock.calls)).not.toContain('must-not-enter-redis');
  });

  it('keeps the credential/process-affine Feathers deny list explicit', () => {
    expect([...REDIS_FEATHERS_DENIED_PATHS]).toEqual(
      expect.arrayContaining([
        'authentication',
        'session-tokens',
        'external-launch',
        'executor-git-environment',
        'mcp-servers/oauth-auth-headers',
        'codex-auth/device',
        'opencode-auth',
        'terminals',
      ])
    );
  });

  for (const path of KNOWLEDGE_REALTIME_SUPPRESSED_CREATE_PATHS) {
    dbTest(
      `suppresses only created ${path} events at local and Redis boundaries`,
      async ({ db }) => {
        const tenantConnection = {
          user: await seedRealtimeUser(db, `event-${path.replaceAll('/', '-')}`),
        };
        const serviceConnection = { user: { _isServiceAccount: true, role: 'service' } };
        const connections = [tenantConnection, serviceConnection];
        let remoteHandler: ((envelope: any) => Promise<void> | void) | undefined;
        const relay = {
          relay: vi.fn(),
          setRelayHandler: vi.fn((handler) => {
            remoteHandler = handler;
          }),
        };
        const app = makeApp(connections, {}, { 'tenant:tenant-a': connections });
        configureRealtimePublish({
          app,
          db,
          branchRbacEnabled: false,
          branchRepository: {} as never,
          sessionsRepository: {} as never,
          multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
          realtimeRelay: relay,
        });
        const createdEnvelope = {
          version: REALTIME_RELAY_VERSION,
          tenantId: 'tenant-a',
          path,
          event: 'created',
          method: 'create',
          data: { boundary: 'created' },
        };

        const createdChannel = await app.runPublish(createdEnvelope.data, {
          path,
          event: createdEnvelope.event,
          method: createdEnvelope.method,
          params: {},
        });
        expect(createdChannel.connections).toEqual([]);
        expect(relay.relay).not.toHaveBeenCalled();

        await remoteHandler?.(createdEnvelope);
        expect(app.emit).not.toHaveBeenCalled();

        const patchedEnvelope = {
          version: REALTIME_RELAY_VERSION,
          tenantId: 'tenant-a',
          path,
          event: 'patched',
          method: 'patch',
          data: { boundary: 'non-created' },
        };

        const patchedChannel = await app.runPublish(patchedEnvelope.data, {
          path,
          event: patchedEnvelope.event,
          method: patchedEnvelope.method,
          params: {},
        });
        expect(patchedChannel.connections).toEqual(connections);
        expect(relay.relay).toHaveBeenCalledWith(patchedEnvelope);

        await remoteHandler?.(patchedEnvelope);
        expect(app.emit).toHaveBeenCalledOnce();
        const receivedChannel = app.emit.mock.calls[0]?.[2] as FakeChannel;
        expect(receivedChannel.connections).toEqual(connections);
      }
    );
  }

  dbTest(
    're-authorizes Knowledge readers on the receiving replica after revocation',
    async ({ db }) => {
      const reader = await seedRealtimeUser(db, 'reader');
      const owner = await seedRealtimeUser(db, 'owner');
      const namespaces = new KnowledgeNamespaceRepository(db);
      const namespace = await namespaces.create({
        slug: 'relay-revocation',
        display_name: 'Relay revocation',
        others_can: 'none',
      });
      const document = await new KnowledgeDocumentRepository(db).create({
        namespace_id: namespace.namespace_id,
        path: 'page.md',
        title: 'Page',
        content_text: '# Page',
        visibility: 'public',
        created_by: owner.user_id,
      });
      await namespaces.upsertNamespaceAclEntry({
        namespace_id: namespace.namespace_id,
        subject_type: 'user',
        subject_id: reader.user_id,
        permission: 'read',
      });

      const readerConnection = { user: reader };
      const serviceConnection = { user: { _isServiceAccount: true, role: 'service' } };
      let remoteHandler: ((envelope: any) => Promise<void> | void) | undefined;
      const relay = {
        relay: vi.fn(),
        setRelayHandler: vi.fn((handler) => {
          remoteHandler = handler;
        }),
      };
      const app = makeApp(
        [readerConnection, serviceConnection],
        {},
        {
          authenticated: [readerConnection, serviceConnection],
          'tenant:tenant-a': [readerConnection, serviceConnection],
        }
      );
      const r = repos({ branch: branch('unused'), permissions: {} });
      configureRealtimePublish({
        app,
        db,
        branchRbacEnabled: false,
        multiTenancy: {
          mode: 'required_from_auth',
          static_tenant_id: 'unused' as never,
          auth_claim: 'tenant_id',
        },
        realtimeRelay: relay,
        ...r,
      });

      await namespaces.removeNamespaceAclEntry(namespace.namespace_id, 'user', reader.user_id);
      await remoteHandler?.({
        version: REALTIME_RELAY_VERSION,
        tenantId: 'tenant-a',
        path: 'kb/documents',
        event: 'patched',
        method: 'patch',
        id: document.document_id,
        data: document,
      });

      expect(app.emit).toHaveBeenCalledOnce();
      const channel = app.emit.mock.calls[0]?.[2] as FakeChannel;
      expect(channel.connections).toEqual([serviceConnection]);
      expect(channel.connections).not.toContain(readerConnection);
    }
  );

  dbTest('reloads current Knowledge principals on the receiving replica', async ({ db }) => {
    const { document, connections, promotedConnection, serviceConnection } =
      await seedCurrentKnowledgePrincipals(db, 'relay');
    let remoteHandler: ((envelope: any) => Promise<void> | void) | undefined;
    const relay = {
      relay: vi.fn(),
      setRelayHandler: vi.fn((handler) => {
        remoteHandler = handler;
      }),
    };
    const app = makeApp(
      connections,
      {},
      {
        authenticated: connections,
        'tenant:tenant-a': connections,
      }
    );
    const r = repos({ branch: branch('unused'), permissions: {} });
    configureRealtimePublish({
      app,
      db,
      branchRbacEnabled: false,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'unused' as never,
        auth_claim: 'tenant_id',
      },
      realtimeRelay: relay,
      ...r,
    });

    await remoteHandler?.({
      version: REALTIME_RELAY_VERSION,
      tenantId: 'tenant-a',
      path: 'kb/documents',
      event: 'patched',
      method: 'patch',
      id: document.document_id,
      data: document,
    });

    expect(app.emit).toHaveBeenCalledOnce();
    const channel = app.emit.mock.calls[0]?.[2] as FakeChannel;
    expect(channel.connections).toEqual([promotedConnection, serviceConnection]);
  });
});

async function seedRealtimeUser(
  db: Database,
  label: string,
  role: User['role'] = ROLES.MEMBER
): Promise<User> {
  return new UsersRepository(db).create({
    user_id: generateId() as UserID,
    email: `${label}-${generateId()}@test.local`,
    name: label,
    role,
  }) as Promise<User>;
}

async function seedCurrentKnowledgePrincipals(db: Database, label: string) {
  const owner = await seedRealtimeUser(db, `${label}-owner`);
  const demoted = await seedRealtimeUser(db, `${label}-demoted`, ROLES.ADMIN);
  const promoted = await seedRealtimeUser(db, `${label}-promoted`);
  const removed = await seedRealtimeUser(db, `${label}-removed`, ROLES.ADMIN);
  const namespace = await new KnowledgeNamespaceRepository(db).create({
    slug: `${label}-current-principals`,
    display_name: `${label} current principals`,
    others_can: 'none',
  });
  const document = await new KnowledgeDocumentRepository(db).create({
    namespace_id: namespace.namespace_id,
    path: 'page.md',
    title: 'Page',
    content_text: '# Page',
    visibility: 'public',
    created_by: owner.user_id,
  });
  const users = new UsersRepository(db);
  await users.update(demoted.user_id, { role: ROLES.MEMBER });
  await users.update(promoted.user_id, { role: ROLES.ADMIN });
  await users.delete(removed.user_id);

  const promotedConnection = { user: promoted };
  const serviceConnection = { user: { _isServiceAccount: true, role: 'service' } };
  const connections = [
    { user: demoted },
    promotedConnection,
    { user: removed },
    // Tenant RLS-hidden and absent principals both resolve to null locally.
    { user: user(generateId(), ROLES.ADMIN) },
    serviceConnection,
  ];
  return { document, connections, promotedConnection, serviceConnection };
}

function repos(options: {
  branch: Branch;
  session?: Session | null;
  permissions: Record<string, Branch['others_can']>;
  /** Owning user id returned by findCreatedByBySessionId (owner-fallback tests). */
  owner?: string | null;
  boardPermissions?: Record<string, boolean>;
  boardAccessMode?: 'private' | 'shared';
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
    findRealtimeViewUserIds: vi.fn(async () => viewableUserIds),
  } as unknown as RealtimeAccessBranchRepository;
  const sessionsRepository = {
    findBranchIdBySessionId: vi.fn(async (id: string) =>
      options.session?.session_id === id ? options.session.branch_id : null
    ),
    findCreatedByBySessionId: vi.fn(async (id: string) =>
      options.session?.session_id === id ? (options.owner ?? null) : null
    ),
  } as unknown as RealtimeAccessSessionRepository;
  const boardRepository = {
    findById: vi.fn(async (boardId: string) => ({
      board_id: boardId,
      access_mode: options.boardAccessMode ?? 'private',
    })),
    findRealtimeViewUserIds: vi.fn(async () =>
      options.boardPermissions
        ? Object.entries(options.boardPermissions)
            .filter(([, canView]) => canView)
            .map(([userId]) => userId)
        : viewableUserIds
    ),
  } as unknown as BoardRepository;
  return { branchRepository, sessionsRepository, boardRepository };
}

describe('configureRealtimePublish', () => {
  it('routes artifact runtime queries only to the requesting user', async () => {
    const requester = { user: user('requester') };
    const otherViewer = { user: user('other-viewer') };
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const app = makeApp([requester, otherViewer, service]);
    const r = repos({ branch: branch('b1'), permissions: {} });
    configureRealtimePublish({ app, branchRbacEnabled: false, ...r });

    const channel = await app.runPublish(
      {
        request_id: 'request-1',
        artifact_id: 'artifact-1',
        requested_by_user_id: 'requester',
        kind: 'query_dom',
        args: { selector: '[data-private]' },
      },
      { path: 'artifacts', method: 'emit', event: 'agor-query', params: {} }
    );

    expect(channel.connections).toEqual([requester]);
  });

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

  dbTest('enforces Knowledge ACLs independently of branch RBAC', async ({ db }) => {
    const owner = await seedRealtimeUser(db, 'owner');
    const allowed = await seedRealtimeUser(db, 'allowed');
    const denied = await seedRealtimeUser(db, 'denied');
    const namespaces = new KnowledgeNamespaceRepository(db);
    const namespace = await namespaces.create({
      slug: 'rbac-independent',
      display_name: 'RBAC independent',
      others_can: 'none',
    });
    const document = await new KnowledgeDocumentRepository(db).create({
      namespace_id: namespace.namespace_id,
      path: 'page.md',
      title: 'Page',
      content_text: '# Page',
      visibility: 'public',
      created_by: owner.user_id,
    });
    await namespaces.upsertNamespaceAclEntry({
      namespace_id: namespace.namespace_id,
      subject_type: 'user',
      subject_id: allowed.user_id,
      permission: 'read',
    });
    const allowedConnection = { user: allowed };
    const deniedConnection = { user: denied };
    const serviceConnection = { user: { _isServiceAccount: true, role: 'service' } };

    for (const branchRbacEnabled of [false, true]) {
      const app = makeApp([allowedConnection, deniedConnection, serviceConnection]);
      const r = repos({ branch: branch('unused'), permissions: {} });
      configureRealtimePublish({ app, db, branchRbacEnabled, ...r });

      const channel = await app.runPublish(document, {
        path: 'kb/documents',
        method: 'patch',
        event: 'patched',
        id: document.document_id,
        params: {},
      });

      expect(channel.connections).toEqual([allowedConnection, serviceConnection]);
    }
  });

  dbTest('reloads current Knowledge principals without reconnecting', async ({ db }) => {
    const { document, connections, promotedConnection, serviceConnection } =
      await seedCurrentKnowledgePrincipals(db, 'local');
    const app = makeApp(
      connections,
      {},
      {
        authenticated: connections,
        'tenant:tenant-a': connections,
      }
    );
    const r = repos({ branch: branch('unused'), permissions: {} });
    configureRealtimePublish({
      app,
      db,
      branchRbacEnabled: false,
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
      ...r,
    });

    const channel = await app.runPublish(document, {
      path: 'kb/documents',
      method: 'patch',
      event: 'patched',
      id: document.document_id,
      params: {},
    });

    expect(channel.connections).toEqual([promotedConnection, serviceConnection]);
  });

  dbTest(
    'contains Knowledge events to the resolved tenant before applying document ACLs',
    async ({ db }) => {
      const owner = await seedRealtimeUser(db, 'owner');
      const tenantAUser = await seedRealtimeUser(db, 'tenant-a-user');
      const tenantBUser = await seedRealtimeUser(db, 'tenant-b-user');
      const namespace = await new KnowledgeNamespaceRepository(db).create({
        slug: 'tenant-contained',
        display_name: 'Tenant contained',
        others_can: 'read',
      });
      const document = await new KnowledgeDocumentRepository(db).create({
        namespace_id: namespace.namespace_id,
        path: 'page.md',
        title: 'Page',
        content_text: '# Page',
        visibility: 'public',
        created_by: owner.user_id,
      });
      const tenantAConnection = { user: tenantAUser };
      const tenantBConnection = { user: tenantBUser };
      const app = makeApp(
        [tenantAConnection, tenantBConnection],
        {},
        {
          authenticated: [tenantAConnection, tenantBConnection],
          'tenant:tenant-a': [tenantAConnection],
          'tenant:tenant-b': [tenantBConnection],
        }
      );
      const r = repos({ branch: branch('unused'), permissions: {} });
      configureRealtimePublish({
        app,
        db,
        branchRbacEnabled: false,
        multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
        ...r,
      });

      const channel = await app.runPublish(document, {
        path: 'kb/documents',
        method: 'patch',
        event: 'patched',
        id: document.document_id,
        params: {},
      });

      expect(channel.connections).toEqual([tenantAConnection]);
      expect(channel.connections).not.toContain(tenantBConnection);
    }
  );

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

    expect(channel).toEqual([]);
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
    const r = repos({
      branch: branch('b1', 'view'),
      permissions: { 'tenant-user': 'view' },
    });
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

    expect(channel).toEqual([]);
    expect(app.channel).not.toHaveBeenCalledWith(tenantChannelName('tenant-a'));
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

  it('delivers a removed branch from its pre-delete visibility snapshot after the row is gone', async () => {
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
    const deletedBranch = branch('b1', 'none');
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(async () => null),
      findRealtimeViewUserIds: vi.fn(async () => []),
    } as unknown as RealtimeAccessBranchRepository;
    const sessionsRepository = {
      findBranchIdBySessionId: vi.fn(async () => null),
      findCreatedByBySessionId: vi.fn(async () => null),
    } as unknown as RealtimeAccessSessionRepository;
    configureRealtimePublish({
      app,
      db: scopeOnlyDb,
      branchRbacEnabled: true,
      branchRepository,
      sessionsRepository,
      multiTenancy: {
        mode: 'required_from_auth',
        static_tenant_id: 'default' as any,
        auth_claim: 'tenant_id',
      },
    });

    const channel = await app.runPublish(deletedBranch, {
      path: 'branches',
      method: 'remove',
      event: 'removed',
      id: 'b1',
      params: {
        tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
        _agorRealtimeBranchRemovalVisibility: {
          branchId: 'b1',
          mode: 'explicitUsers',
          userIds: ['allowed'],
        },
      },
    });

    expect(channel.connections).toEqual([allowedConnection]);
    expect(branchRepository.findRealtimeVisibilityBranch).not.toHaveBeenCalled();
  });

  it('fails a branch removal closed when its server-captured visibility snapshot is missing', async () => {
    const allowed = { user: user('allowed') };
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const app = makeApp([allowed, service]);
    const r = repos({
      branch: branch('b1', 'view'),
      permissions: { allowed: 'view' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(branch('b1', 'view'), {
      path: 'branches',
      method: 'remove',
      event: 'removed',
      id: 'b1',
      params: {},
    });

    expect(channel.connections).toEqual([service]);
    expect(r.branchRepository.findRealtimeVisibilityBranch).not.toHaveBeenCalled();
  });

  it('does not broadcast branch permission mutation payloads', async () => {
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
        path: 'branches/:id/permissions',
        method: 'patch',
        event: 'patched',
        params: { route: { id: 'b1' } },
      }
    );

    expect(channel.connections ?? []).toEqual([]);
  });

  it('does not broadcast board permission mutation payloads', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const app = makeApp([{ user: allowed }, { user: denied }]);
    const r = repos({
      branch: branch('b1', 'none'),
      permissions: { allowed: 'view', denied: 'none' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { board_access_revision: 2 },
      {
        path: 'boards/:id/permissions',
        method: 'patch',
        event: 'patched',
        params: { route: { id: 'board-1' } },
      }
    );

    expect(channel.connections ?? []).toEqual([]);
  });

  it('publishes broadly visible branch events only to the materialized audience', async () => {
    const u1 = user('u1');
    const u2 = user('u2');
    const app = makeApp([{ user: u1 }, { user: u2 }]);
    const r = repos({
      branch: branch('b1', 'session'),
      permissions: { u1: 'view', u2: 'view' },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { branch_id: 'b1' },
      { path: 'branches', method: 'patch', event: 'patched' }
    );

    expect(channel.connections).toEqual([{ user: u1 }, { user: u2 }]);
    expect(vi.mocked(r.branchRepository.findRealtimeViewUserIds)).toHaveBeenCalledOnce();
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
      permissions: { 'owner-user': 'view' },
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

  it('authorizes attached board comment events through the branch, not broad board visibility', async () => {
    const allowed = user('allowed');
    const denied = user('denied');
    const app = makeApp([{ user: allowed }, { user: denied }]);
    const r = repos({
      branch: branch('b1', 'none'),
      permissions: { allowed: 'view', denied: 'none' },
      boardPermissions: { allowed: true, denied: true },
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const channel = await app.runPublish(
      { comment_id: 'c1', board_id: 'private-board', branch_id: 'b1' },
      { path: 'board-comments', method: 'create', event: 'created' }
    );

    expect(r.boardRepository.findRealtimeViewUserIds).not.toHaveBeenCalled();
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

  it('fails closed when a board-attached event has no board id', async () => {
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

    expect(channel.connections).toEqual([]);
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
    expect(app.channels).not.toContain(sessionStreamRoomName('standalone', 's1'));
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

    expect(app.channels).toContain(sessionStreamRoomName('standalone', 's1'));
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

    expect(app.channels).not.toContain(sessionStreamRoomName('standalone', 's1'));
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

  it('skips the owner fallback for an owner connection that announced session-streams awareness (the idle-firehose fix)', async () => {
    const ownerIdle = { user: user('owner-user') };
    markConnectionSessionStreamsAware(ownerIdle);
    const other = { user: user('other-user') };
    const app = makeApp(
      [ownerIdle, other],
      {},
      {
        authenticated: [ownerIdle, other],
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

    expect(unionConnections(result)).toEqual([]);
  });

  it('delivers to an announced+subscribed owner connection via the room exactly once (no double, no drop)', async () => {
    // Union can't catch a double-delivery, so count raw occurrences across channels.
    const ownerSubscribed = { user: user('owner-user') };
    markConnectionSessionStreamsAware(ownerSubscribed);
    const app = makeApp(
      [ownerSubscribed],
      {},
      {
        authenticated: [ownerSubscribed],
        'session-stream:s1': [ownerSubscribed],
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

    const channels = Array.isArray(result) ? result : [result];
    const rawDeliveries = channels.flatMap((c) => (c as FakeChannel).connections);
    expect(rawDeliveries.filter((c) => c === ownerSubscribed)).toHaveLength(1);
    expect(unionConnections(result)).toEqual([ownerSubscribed]);
  });

  it('keeps the owner fallback per-session: subscribing to A does not drop owned B', async () => {
    // One owner connection subscribed to A's room, but only raw-listens to owned
    // B (never joined B's room). B must still reach it via the fallback; A must
    // reach it via the room exactly once (not doubled by the fallback).
    const owner = { user: user('owner-user') };
    const app = makeApp(
      [owner],
      {},
      {
        authenticated: [owner],
        'session-stream:sA': [owner],
        'session-stream:sB': [],
      }
    );
    const branchRepository = {
      findRealtimeVisibilityBranch: vi.fn(async () => branch('b1', 'view')),
      findRealtimeViewUserIds: vi.fn(async () => []),
    } as unknown as RealtimeAccessBranchRepository;
    const sessionsRepository = {
      findBranchIdBySessionId: vi.fn(async () => 'b1'),
      findCreatedByBySessionId: vi.fn(async () => 'owner-user'),
    } as unknown as RealtimeAccessSessionRepository;
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      branchRepository,
      sessionsRepository,
    });

    // B: connection is not in B's room → owner fallback still delivers.
    const bResult = await app.runPublish(
      { session_id: 'sB', message_id: 'm1', chunk: 'b' },
      streamingContext
    );
    expect(unionConnections(bResult)).toEqual([owner]);

    // A: connection is in A's room → delivered via the room exactly once, the
    // fallback excludes it. Union hides a double, so count raw occurrences.
    const aResult = await app.runPublish(
      { session_id: 'sA', message_id: 'm2', chunk: 'a' },
      streamingContext
    );
    const aChannels = Array.isArray(aResult) ? aResult : [aResult];
    const aRaw = aChannels.flatMap((c) => (c as FakeChannel).connections);
    expect(aRaw.filter((c) => c === owner)).toHaveLength(1);
    expect(unionConnections(aResult)).toEqual([owner]);
  });

  it('still bridges a stale owner connection that never announced (safety net)', async () => {
    const staleOwner = { user: user('owner-user') };
    const other = { user: user('other-user') };
    const app = makeApp(
      [staleOwner, other],
      {},
      {
        authenticated: [staleOwner, other],
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

    expect(unionConnections(result)).toEqual([staleOwner]);
  });

  it('still delivers to service accounts when the owner announced awareness', async () => {
    const ownerIdle = { user: user('owner-user') };
    markConnectionSessionStreamsAware(ownerIdle);
    const service = { user: { _isServiceAccount: true, role: 'service' } };
    const app = makeApp(
      [ownerIdle, service],
      {},
      {
        authenticated: [ownerIdle, service],
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

    expect(unionConnections(result)).toEqual([service]);
  });

  it('skips the owner fallback for an aware owner even under branch RBAC (allAuthenticated)', async () => {
    const ownerIdle = { user: user('owner-user') };
    markConnectionSessionStreamsAware(ownerIdle);
    const other = { user: user('other-user') };
    const app = makeApp(
      [ownerIdle, other],
      {},
      {
        authenticated: [ownerIdle, other],
        'session-stream:s1': [],
      }
    );
    const r = repos({
      branch: branch('b1', 'view'),
      session: session('s1', 'b1'),
      permissions: { 'owner-user': 'view', 'other-user': 'view' },
      owner: 'owner-user',
    });
    configureRealtimePublish({ app, branchRbacEnabled: true, ...r });

    const result = await app.runPublish(
      { session_id: 's1', message_id: 'm1', chunk: 'hi' },
      streamingContext
    );

    expect(unionConnections(result)).toEqual([]);
  });

  it('skips the owner fallback for an aware owner even under branch RBAC (explicit-users)', async () => {
    // Owner holds view, so the fallback would fire — but the aware connection is still skipped.
    const ownerIdle = { user: user('owner-user') };
    markConnectionSessionStreamsAware(ownerIdle);
    const other = { user: user('other-user') };
    const app = makeApp(
      [ownerIdle, other],
      {},
      {
        authenticated: [ownerIdle, other],
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
      { session_id: 's1', message_id: 'm1', chunk: 'hi' },
      streamingContext
    );

    expect(unionConnections(result)).toEqual([]);
  });

  it('does not deliver to a non-owner, non-subscribed connection regardless of awareness (unchanged)', async () => {
    // Awareness only removes an owner from the fallback; it never grants a non-owner streaming.
    const ownerIdle = { user: user('owner-user') };
    markConnectionSessionStreamsAware(ownerIdle);
    const strangerAware = { user: user('stranger') };
    markConnectionSessionStreamsAware(strangerAware);
    const app = makeApp(
      [ownerIdle, strangerAware],
      {},
      {
        authenticated: [ownerIdle, strangerAware],
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

    expect(unionConnections(result)).toEqual([]);
  });
});

/**
 * The allowlist inverts Feathers' default: the app-level publisher runs for
 * every service that has no publisher of its own, so a path nobody declared
 * used to broadcast tenant-wide. These drive the real publisher rather than
 * inspecting the policy table, so a table entry that the publisher does not
 * actually honour still fails.
 */
describe('configureRealtimePublish default-deny allowlist', () => {
  const allowlistApp = (connections: unknown[]) =>
    makeApp(connections, { tasks: { get: vi.fn(async () => ({ session_id: 's1' })) } });

  const rbacRepos = () =>
    repos({
      branch: branch('b1', 'none'),
      session: session('s1', 'b1'),
      permissions: { allowed: 'view', denied: 'none' },
    });

  /** runPublish returns a channel, or an array of them, or [] for a denial. */
  const delivered = (result: unknown): unknown[] => {
    const channels = (Array.isArray(result) ? result : [result]) as (FakeChannel | undefined)[];
    return [...new Set(channels.flatMap((channel) => channel?.connections ?? []))];
  };

  it('publishes an undeclared service to nobody, with branch RBAC off', async () => {
    const app = allowlistApp([{ user: user('u1') }, { user: user('u2') }]);
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      ...repos({ branch: branch('b1'), permissions: {} }),
    });

    const result = await app.runPublish(
      { branch_id: 'b1', secret: 'sk-live-leak' },
      { path: 'a-service-nobody-declared', method: 'create', event: 'created', params: {} }
    );

    expect(delivered(result)).toEqual([]);
  });

  it('publishes an undeclared service to nobody, with branch RBAC on', async () => {
    const app = allowlistApp([{ user: user('allowed') }, { user: user('denied') }]);
    configureRealtimePublish({ app, branchRbacEnabled: true, ...rbacRepos() });

    const result = await app.runPublish(
      { branch_id: 'b1' },
      { path: 'a-service-nobody-declared', method: 'create', event: 'created', params: {} }
    );

    expect(delivered(result)).toEqual([]);
  });

  it('publishes an undeclared service to nobody even on a service connection', async () => {
    // Service accounts are the escape hatch every other suppression path keeps
    // open. An undeclared path has none: nobody decided, so nobody hears it.
    const executor = { user: { _isServiceAccount: true, role: 'service' } };
    const app = allowlistApp([executor, { user: user('u1') }]);
    configureRealtimePublish({
      app,
      branchRbacEnabled: true,
      ...repos({ branch: branch('b1'), permissions: {} }),
    });

    const result = await app.runPublish(
      { branch_id: 'b1' },
      { path: 'a-service-nobody-declared', method: 'patch', event: 'patched', params: {} }
    );

    expect(delivered(result)).toEqual([]);
  });

  it('suppresses an event with no path at all', async () => {
    const app = allowlistApp([{ user: user('u1') }]);
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      ...repos({ branch: branch('b1'), permissions: {} }),
    });

    const result = await app.runPublish(
      { branch_id: 'b1' },
      { method: 'create', event: 'created' }
    );

    expect(delivered(result)).toEqual([]);
  });

  it.each([
    // The RPC route that leaked a credential-bearing mcp_server row (PR #2451).
    ['mcp-catalog/connect', { mcp_server: { api_key: 'sk-live-leak' }, session: {} }],
    // The rest of the credential control plane, each of which emits `created`
    // with its own response body purely because Feathers registers it.
    ['config/resolve-api-key', { api_key: 'sk-live-leak' }],
    ['api/v1/user/api-keys', { key: 'agor_pat_leak' }],
    ['check-auth', { apiKey: 'sk-live-leak' }],
    ['mcp-servers/oauth-auth-headers', { Authorization: 'Bearer leak' }],
    ['mcp-servers/discover', { tools: [] }],
    ['branches/logs', { logs: 'DATABASE_URL=postgres://user:pw@host/db' }],
    ['repos/clone', { url: 'https://token@github.com/org/repo' }],
    ['session-env-selections', { session_id: 's1', env_var_name: 'PRIVATE_TOKEN' }],
    ['sessions/:id/fork', { session_id: 's1', branch_id: 'b1' }],
    ['terminals', { terminal_id: 't1' }],
  ])('publishes %s to nobody', async (path, data) => {
    const app = allowlistApp([{ user: user('u1') }, { user: user('u2') }]);
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      ...repos({ branch: branch('b1'), permissions: {} }),
    });

    const result = await app.runPublish(data, {
      path,
      method: 'create',
      event: 'created',
      params: {},
    });

    expect(delivered(result)).toEqual([]);
  });

  it('keeps an undeclared event off the Redis relay', async () => {
    // A denied path must not reach other replicas either — otherwise the leak
    // just moves one hop and re-enters through the relay handler.
    const relayed: unknown[] = [];
    const app = allowlistApp([{ user: user('u1') }]);
    configureRealtimePublish({
      app,
      branchRbacEnabled: false,
      multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
      realtimeRelay: {
        relay: (envelope) => relayed.push(envelope),
        setRelayHandler: () => {},
      },
      ...repos({ branch: branch('b1'), permissions: {} }),
    });

    await app.runPublish(
      { mcp_server: { api_key: 'sk-live-leak' } },
      { path: 'mcp-catalog/connect', method: 'create', event: 'created', params: {} }
    );
    // A declared path on the same publisher still relays, so this asserts the
    // gate rather than a relay that never fires.
    await app.runPublish(
      { branch_id: 'b1' },
      { path: 'branches', method: 'patch', event: 'patched', params: {} }
    );

    expect(relayed).toHaveLength(1);
    expect((relayed[0] as { path: string }).path).toBe('branches');
  });

  describe('declared services still reach their audience', () => {
    // One case per declared fan-out path. Branch RBAC is ON and only `allowed`
    // can see branch b1, so a path that silently fell back to a tenant-wide
    // broadcast — or to nobody — fails here rather than passing by accident.
    const branchScoped: Array<[string, Record<string, unknown>]> = [
      ['sessions', { session_id: 's1' }],
      ['tasks', { session_id: 's1' }],
      ['messages', { session_id: 's1' }],
      ['session-mcp-servers', { session_id: 's1' }],
      ['branches', { branch_id: 'b1' }],
      ['schedules', { branch_id: 'b1' }],
      ['artifacts', { branch_id: 'b1' }],
    ];

    it.each(branchScoped)('%s reaches the users who can see the branch', async (path, data) => {
      const allowed = { user: user('allowed') };
      const denied = { user: user('denied') };
      const app = allowlistApp([allowed, denied]);
      configureRealtimePublish({ app, branchRbacEnabled: true, ...rbacRepos() });

      const result = await app.runPublish(data, {
        path,
        method: 'patch',
        event: 'patched',
        params: {},
      });

      expect(delivered(result)).toEqual([allowed]);
    });

    it('branches/:id/permissions does not expose policy payloads', async () => {
      const allowed = { user: user('allowed') };
      const denied = { user: user('denied') };
      const app = allowlistApp([allowed, denied]);
      configureRealtimePublish({ app, branchRbacEnabled: true, ...rbacRepos() });

      // The payload is a bare User with no branch id — the route param is the
      // only thing that can scope it.
      const result = await app.runPublish(
        { user_id: 'allowed' },
        {
          path: 'branches/:id/permissions',
          method: 'patch',
          event: 'patched',
          params: { route: { id: 'b1' } },
        }
      );

      expect(delivered(result)).toEqual([]);
    });

    it('boards/:id/permissions does not expose policy payloads', async () => {
      const allowed = { user: user('allowed') };
      const denied = { user: user('denied') };
      const app = allowlistApp([allowed, denied]);
      configureRealtimePublish({ app, branchRbacEnabled: true, ...rbacRepos() });

      const result = await app.runPublish(
        { board_access_revision: 2 },
        {
          path: 'boards/:id/permissions',
          method: 'patch',
          event: 'patched',
          params: { route: { id: 'board-1' } },
        }
      );

      expect(delivered(result)).toEqual([]);
    });

    it.each([
      'card-types',
      'repos',
      'users',
      'mcp-servers',
      'gateway-channels',
      'agentic-tool-settings',
    ])('%s reaches the whole tenant', async (path) => {
      const u1 = { user: user('u1') };
      const u2 = { user: user('u2') };
      const app = allowlistApp([u1, u2]);
      configureRealtimePublish({
        app,
        branchRbacEnabled: true,
        ...repos({ branch: branch('b1'), permissions: {} }),
      });

      const result = await app.runPublish(
        { some_id: 'x1' },
        { path, method: 'patch', event: 'patched', params: {} }
      );

      expect(delivered(result)).toEqual([u1, u2]);
    });

    it.each(['boards', 'board-objects', 'board-comments', 'cards'])(
      '%s reaches only users who can currently view a private board',
      async (path) => {
        const allowed = { user: user('allowed') };
        const denied = { user: user('denied') };
        const admin = { user: user('admin', ROLES.ADMIN) };
        const app = allowlistApp([allowed, denied, admin]);
        configureRealtimePublish({
          app,
          branchRbacEnabled: true,
          ...repos({
            branch: branch('b1'),
            permissions: {},
            boardPermissions: { allowed: true, denied: false, admin: false },
          }),
        });

        const result = await app.runPublish(
          { board_id: 'private-board', access_mode: 'private' },
          { path, method: 'patch', event: 'patched', params: {} }
        );

        expect(delivered(result)).toEqual([allowed, admin]);
      }
    );

    it('does not trust a local shared payload over the current private board', async () => {
      const allowed = { user: user('allowed') };
      const denied = { user: user('denied') };
      const app = allowlistApp([allowed, denied]);
      configureRealtimePublish({
        app,
        branchRbacEnabled: true,
        ...repos({
          branch: branch('unused'),
          permissions: {},
          boardPermissions: { allowed: true, denied: false },
        }),
      });

      const result = await app.runPublish(
        { board_id: 'private-board', access_mode: 'shared' },
        { path: 'boards', method: 'patch', event: 'patched', params: {} }
      );

      expect(delivered(result)).toEqual([allowed]);
    });

    it('a board row reaches only principals allowed by the board policy', async () => {
      const u1 = { user: user('u1') };
      const u2 = { user: user('u2') };
      const app = allowlistApp([u1, u2]);
      configureRealtimePublish({
        app,
        branchRbacEnabled: true,
        ...repos({
          branch: branch('b1', 'none'),
          permissions: {},
          boardPermissions: { u1: true, u2: true },
        }),
      });

      const result = await app.runPublish(
        { board_id: 'shared-board', access_mode: 'shared' },
        { path: 'boards', method: 'patch', event: 'patched', params: {} }
      );

      expect(delivered(result)).toEqual([u1, u2]);
    });

    it('a board-attached event without a board id fails closed', async () => {
      const member = { user: user('u1') };
      const service = { user: { _isServiceAccount: true, role: 'service' } };
      const app = allowlistApp([member, service]);
      configureRealtimePublish({ app, branchRbacEnabled: true, ...rbacRepos() });

      const result = await app.runPublish(
        { board_object_id: 'o1' },
        { path: 'board-objects', method: 'patch', event: 'patched', params: {} }
      );

      expect(delivered(result)).toEqual([service]);
    });

    it('enforces the users read-role floor against adversarial viewer listeners', async () => {
      const viewer = { user: user('viewer', ROLES.VIEWER) };
      const member = { user: user('member', ROLES.MEMBER) };
      const admin = { user: user('admin', ROLES.ADMIN) };
      const service = { user: { _isServiceAccount: true, role: 'service' } };
      const app = allowlistApp([viewer, member, admin, service]);
      configureRealtimePublish({
        app,
        branchRbacEnabled: false,
        ...repos({ branch: branch('b1'), permissions: {} }),
      });

      const result = await app.runPublish(
        { user_id: 'changed-user', role: ROLES.ADMIN },
        { path: 'users', method: 'patch', event: 'patched', params: {} }
      );

      expect(delivered(result)).toEqual([member, admin, service]);
      expect(delivered(result)).not.toContain(viewer);
    });

    it('enforces the board-object read-role floor after branch visibility admits a viewer', async () => {
      const viewer = { user: user('viewer', ROLES.VIEWER) };
      const member = { user: user('member', ROLES.MEMBER) };
      const admin = { user: user('admin', ROLES.ADMIN) };
      const service = { user: { _isServiceAccount: true, role: 'service' } };
      const app = allowlistApp([viewer, member, admin, service]);
      const allowed = repos({
        branch: branch('b1', 'view'),
        permissions: { viewer: 'view', member: 'view', admin: 'view' },
      });
      configureRealtimePublish({ app, branchRbacEnabled: true, ...allowed });

      const result = await app.runPublish(
        { board_object_id: 'o1', branch_id: 'b1' },
        { path: 'board-objects', method: 'patch', event: 'patched', params: {} }
      );

      expect(delivered(result)).toEqual([member, admin, service]);
      expect(delivered(result)).not.toContain(viewer);
    });

    it.each([
      'kb/documents',
      'kb/namespaces',
      'kb/versions',
      'kb/graph',
      'kb/settings',
      'kb/indexing/status',
    ])('%s is routed to the Knowledge resolver, not to the tenant', async (path) => {
      // Without a database the Knowledge resolver can authorize nobody, so it
      // returns an empty reader set and only service connections receive. What
      // matters here is that the path is neither denied outright nor allowed to
      // fall through to the tenant-wide branch — the seeded dbTests above pin
      // the real reader sets.
      const service = { user: { _isServiceAccount: true, role: 'service' } };
      const member = { user: user('u1') };
      const app = allowlistApp([service, member]);
      configureRealtimePublish({
        app,
        branchRbacEnabled: false,
        ...repos({ branch: branch('b1'), permissions: {} }),
      });

      const result = await app.runPublish(
        { document_id: 'd1' },
        { path, method: 'patch', event: 'patched', params: {} }
      );

      expect(delivered(result)).toEqual([service]);
    });

    it('still routes executor task control to the private room', async () => {
      // tasks/messages carry the executor control events, which resolve before
      // branch scoping. The gate must not swallow them.
      const browser = { user: user('browser') };
      const executor = { user: user('executor') };
      const room = executorTaskChannelName('tenant-a', 'task-1');
      const app = makeApp([browser, executor], {}, { [room]: [executor] });
      configureRealtimePublish({
        app,
        branchRbacEnabled: false,
        multiTenancy: { mode: 'static', static_tenant_id: 'tenant-a' as never },
        ...repos({ branch: branch('b1'), permissions: {} }),
      });

      const result = await app.runPublish(
        { task_id: 'task-1', status: 'stopping' },
        { path: 'tasks', method: 'patch', event: 'termination_requested', params: {} }
      );

      expect(delivered(result)).toEqual([executor]);
    });
  });

  it('declares an audience for every path the publisher special-cases', () => {
    // The publisher names these paths directly (streaming, executor control,
    // Redis denial). If one were dropped from the policy the gate would deny it
    // before that special case ever ran.
    for (const path of ['messages', 'tasks', 'branches', 'artifacts', 'messages/streaming']) {
      expect(realtimePublishPolicyFor(path), `${path} is not declared`).toBeDefined();
    }
    // Conversely, everything the Redis denylist protects must be denied here
    // too — the allowlist is meant to be the stricter of the two.
    for (const path of REDIS_FEATHERS_DENIED_PATHS) {
      expect(isRealtimePublishAllowed(path), `${path} may publish`).toBe(false);
    }
  });
});
