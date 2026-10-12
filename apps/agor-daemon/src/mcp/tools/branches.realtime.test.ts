import {
  BoardObjectRepository,
  BranchRepository,
  getCurrentTenantId,
  runWithoutTenantDatabaseScope,
} from '@agor/core/db';
import { type Application, feathers, socketio } from '@agor/core/feathers';
import type { RealtimeRelayEnvelope } from '@agor/core/realtime';
import type { BoardEntityObject, Branch, HookContext } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tenantChannelName } from '../../realtime/routing';
import { type RegisterHooksContext, registerHooks } from '../../register-hooks';
import { BoardObjectsService } from '../../services/board-objects';
import { ReposService } from '../../services/repos';
import { configureRealtimePublish } from '../../utils/realtime-publish';
import { createTenantDatabaseScopeAroundHook } from '../../utils/tenant-db-scope';
import { registerBranchTools } from './branches';

// Actual MCP -> ReposService -> wrapped CRUD -> publisher -> receiving publisher.
// Only persistence/commit visibility, executor work, and the Redis wire are fakes.
// No production files, branches, sockets, or credentials are used.
const tenantId = 'tenant-a';
const branchId = 'fixture-branch' as Branch['branch_id'];
const boardId = 'fixture-board' as Branch['board_id'];
const userId = 'fixture-reader';
const zoneId = 'fixture-zone';
const params = {
  tenant: { tenant_id: tenantId, source: 'explicit' },
  user: { user_id: userId, role: 'member' },
} as HookContext['params'];

type AfterHook = (context: HookContext) => HookContext | Promise<HookContext>;
function creationHooks() {
  const captured = new Map<string, AfterHook[]>();
  registerHooks({
    app: {
      service(path: string) {
        return {
          hooks(hooks: { after?: { create?: AfterHook[] } }) {
            if (hooks.after?.create) captured.set(path, hooks.after.create);
          },
        };
      },
      use() {},
      publish() {},
    },
    db: {},
    config: { multi_tenancy: { mode: 'static', static_tenant_id: tenantId } },
    jwtSecret: 'fixture-only',
    requireAuth: async (context: HookContext) => context,
    superadminOpts: { allowSuperadmin: false },
    sessionsService: {},
    messagesService: {},
    branchRepository: {},
    usersRepository: {},
    sessionsRepository: {},
    deployment: { mode: 'standalone' },
  } as unknown as RegisterHooksContext);
  return captured;
}

async function fixture(options: { rollback?: boolean; storageMode?: 'clone' | 'worktree' } = {}) {
  let committed = false;
  let branch: Branch;
  let placement: BoardEntityObject;
  const trace: string[] = [];
  const tx = { execute: vi.fn(async () => []) };
  const db = {
    execute: vi.fn(async () => []),
    transaction: async (work: (scoped: typeof tx) => Promise<unknown>) => {
      const result = await work(tx);
      if (!committed) {
        // Give automatic events a deterministic opportunity to reach daemon B
        // BEFORE commit. This is exactly what nested Feathers CRUD used to do.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (options.rollback) throw new Error('fixture rollback');
        committed = true;
        trace.push('commit');
      }
      return result;
    },
  };
  vi.spyOn(BranchRepository.prototype, 'findByRepoAndName').mockResolvedValue(null);
  vi.spyOn(BranchRepository.prototype, 'getAllUsedUniqueIds').mockResolvedValue([]);
  vi.spyOn(BoardObjectRepository.prototype, 'create').mockImplementation(async (data) => {
    placement = {
      ...data,
      object_id: 'fixture-placement',
      entity_type: 'branch',
    } as BoardEntityObject;
    return placement;
  });

  const source = feathers() as Application;
  const remote = feathers() as Application;
  for (const app of [source, remote]) app.configure(socketio());
  source.set('config', { multi_tenancy: { mode: 'static', static_tenant_id: tenantId } });
  const hooks = creationHooks();
  source.use('branches', {
    async create(data: Partial<Branch>) {
      branch = { ...data, branch_id: branchId, archived: false } as Branch;
      trace.push('insert:branch');
      return branch;
    },
    async get() {
      // The MCP readiness/ref-resolution read happens after the create scope.
      expect(committed).toBe(true);
      if (branch.filesystem_status === 'creating') {
        await source.service('branches').patch(
          branchId,
          {
            filesystem_status: 'ready',
            base_ref: 'main',
            base_sha: 'a'.repeat(40),
          },
          params
        );
      }
      return branch;
    },
    async patch(_id: string, data: Partial<Branch>) {
      branch = { ...branch, ...data };
      return branch;
    },
  });
  source.use('board-objects', new BoardObjectsService(db as never, source));
  source.use('boards', {
    async get() {
      return {
        board_id: boardId,
        objects: {
          [zoneId]: {
            type: 'zone',
            x: 1000,
            y: 2000,
            width: 1600,
            height: 800,
          },
        },
      };
    },
  });
  const repos = new ReposService(db as never, source);
  vi.spyOn(repos, 'get').mockResolvedValue({
    repo_id: 'fixture-repo',
    slug: 'fixture/repo',
    default_branch: 'main',
    remote_url: 'https://example.com/fixture.git',
  } as never);
  // Materialization is asynchronous. The get above simulates its later full
  // ready patch; no Git/executor process is started by this fixture.
  vi.spyOn(
    repos as never as { dispatchBranchProvisioning: (branch: Branch) => Promise<Branch> },
    'dispatchBranchProvisioning'
  ).mockImplementation(async (created) => created);
  source.use('repos', repos);
  const scopeHook = createTenantDatabaseScopeAroundHook({
    db: db as never,
    jwtSecret: 'fixture-only',
    config: { multi_tenancy: { mode: 'static', static_tenant_id: tenantId } },
  });
  // The UI/CLI route owns the same outer tenant scope, but returns immediately
  // and passes a viewport position instead of MCP's zone placement.
  source.use('repos/:id/branches', {
    async create() {
      return repos.createBranch(
        'fixture-repo',
        {
          name: 'ui-fixture',
          ref: 'ui-fixture',
          refType: 'branch',
          boardId: boardId!,
          position: { x: 320, y: 240 },
          storage_mode: 'clone',
        },
        params
      );
    },
  });
  source.service('repos/:id/branches').hooks({ around: { all: [scopeHook] } });
  for (const path of ['branches', 'board-objects']) {
    source
      .service(path)
      .hooks({ around: { all: [scopeHook] }, after: { create: hooks.get(path) } });
    for (const event of ['created', 'patched']) {
      source
        .service(path)
        .on(event, () => trace.push(`${path}.${event}:${committed ? 'committed' : 'uncommitted'}`));
    }
  }

  const reader = { user: { user_id: userId, role: 'member' } };
  const denied = { user: { user_id: 'no-branch-access', role: 'member' } };
  // Same user id in another tenant must still receive nothing.
  const foreign = { user: { user_id: userId, role: 'admin' } };
  for (const app of [source, remote]) {
    app.channel('authenticated').join(reader, denied, foreign);
    app.channel(tenantChannelName(tenantId)).join(reader, denied);
    app.channel(tenantChannelName('tenant-b')).join(foreign);
  }
  const deliveries: Array<{ path: string; event: string; data: unknown; connections: unknown[] }> =
    [];
  remote.on('publish', (event, channel, hook, data) => {
    deliveries.push({ event, path: hook.path, data, connections: channel.connections });
  });
  let receive!: (envelope: RealtimeRelayEnvelope) => Promise<void>;
  const relays: Promise<void>[] = [];
  const visibilityRepository = (remoteRead: boolean) => ({
    async findRealtimeVisibilityBranch() {
      expect(getCurrentTenantId()).toBe(tenantId);
      return !remoteRead || committed ? { branch_id: branchId } : null;
    },
    async findRealtimeViewUserIds() {
      return [userId];
    },
  });
  configureRealtimePublish({
    app: remote,
    db: { run() {} } as never,
    branchRepository: visibilityRepository(true) as never,
    sessionsRepository: {} as never,
    allowSuperadmin: false,
    multiTenancy: { mode: 'required_from_auth', static_tenant_id: 'unused' as never },
    realtimeRelay: {
      relay: vi.fn(),
      setRelayHandler(handler) {
        receive = async (envelope) => {
          await handler(envelope);
        };
      },
    },
  });
  configureRealtimePublish({
    app: source,
    db: db as never,
    branchRepository: visibilityRepository(false) as never,
    sessionsRepository: {} as never,
    allowSuperadmin: false,
    multiTenancy: { mode: 'required_from_auth', static_tenant_id: 'unused' as never },
    realtimeRelay: {
      setRelayHandler() {},
      relay(envelope) {
        // A Redis receiver has no access to the originating transaction's ALS.
        relays.push(
          runWithoutTenantDatabaseScope(() => receive(JSON.parse(JSON.stringify(envelope))))
        );
      },
    },
  });
  let create!: (args: Record<string, unknown>) => Promise<unknown>;
  registerBranchTools(
    {
      registerTool(name: string, _config: unknown, handler: typeof create) {
        if (name === 'agor_branches_create') create = handler;
      },
    } as unknown as McpServer,
    {
      app: source,
      db: db as never,
      userId: userId as never,
      authenticatedUser: params.user,
      baseServiceParams: params,
    } as Parameters<typeof registerBranchTools>[1]
  );
  await source.setup();
  await remote.setup();
  return {
    source,
    remote,
    trace,
    deliveries,
    reader,
    denied,
    foreign,
    get placement() {
      return placement;
    },
    createFromRoute: () => source.service('repos/:id/branches').create({}, params),
    create: (waitForReady = true) =>
      create({
        repoId: 'fixture-repo',
        branchName: 'realtime-fixture',
        boardId,
        zoneId,
        storage_mode: options.storageMode ?? 'clone',
        autoSuffix: false,
        waitForReady,
      }),
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.all(relays);
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('MCP branch creation commit-bound realtime', () => {
  it.each([
    ['clone', true],
    ['clone', false],
    ['worktree', true],
    ['worktree', false],
  ] as const)(
    'publishes branch + zone placement to an already-connected reader (%s, wait=%s)',
    async (storageMode, waitForReady) => {
      const f = await fixture({ storageMode });
      try {
        await f.create(waitForReady);
        await f.settle();
        expect(f.deliveries.map(({ path, event }) => `${path}.${event}`)).toEqual(
          expect.arrayContaining(['branches.created', 'board-objects.created', 'branches.patched'])
        );
        expect(f.trace.some((step) => step.endsWith(':uncommitted'))).toBe(false);
        expect(
          f.deliveries.find((e) => e.path === 'branches' && e.event === 'created')?.data
        ).toMatchObject({
          board_id: boardId,
          filesystem_status: 'creating',
          storage_mode: storageMode,
        });
        for (const path of ['branches', 'board-objects']) {
          expect(f.deliveries.filter((e) => e.path === path && e.event === 'created')).toHaveLength(
            1
          );
        }
        expect(f.placement).toMatchObject({
          board_id: boardId,
          branch_id: branchId,
          zone_id: zoneId,
        });
        expect(f.placement.position.x).toBeGreaterThanOrEqual(0);
        expect(f.placement.position.x).toBeLessThan(1600);
        for (const delivery of f.deliveries) {
          expect(delivery.connections).toEqual([f.reader]);
          expect(delivery.connections).not.toContain(f.denied);
          expect(delivery.connections).not.toContain(f.foreign);
        }
        const ready = f.deliveries.find((e) => e.path === 'branches' && e.event === 'patched');
        expect(ready?.data).toMatchObject({ filesystem_status: 'ready', board_id: boardId });
        // A ready patch is not a placement event: it cannot repair a lost create.
        expect(ready?.data).not.toHaveProperty('object_id');
      } finally {
        await f.source.teardown();
        await f.remote.teardown();
      }
    }
  );

  it('also publishes UI/CLI placement before readiness, without an extra route or patched event', async () => {
    const f = await fixture();
    try {
      expect(await f.createFromRoute()).toMatchObject({ filesystem_status: 'creating' });
      await f.settle();
      expect(f.deliveries.map(({ path, event }) => `${path}.${event}`).sort()).toEqual([
        'board-objects.created',
        'branches.created',
      ]);
      expect(f.placement.position).toEqual({ x: 320, y: 240 });
      expect(f.placement.zone_id).toBeUndefined();
      expect(f.trace.some((step) => step.endsWith(':uncommitted'))).toBe(false);
    } finally {
      await f.source.teardown();
      await f.remote.teardown();
    }
  });

  it('publishes neither row when the outer creation transaction rolls back', async () => {
    const f = await fixture({ rollback: true });
    try {
      await expect(f.create()).rejects.toThrow('fixture rollback');
      await f.settle();
      expect(f.deliveries).toEqual([]);
      expect(f.trace.filter((step) => step.includes('.created:'))).toEqual([]);
    } finally {
      await f.source.teardown();
      await f.remote.teardown();
    }
  });
});
