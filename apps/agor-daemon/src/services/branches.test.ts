import {
  BoardRepository,
  BranchRepository,
  type Database,
  GroupRepository,
  KnowledgeNamespaceRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '@agor/core/db';
import type { Application, BoardID, BranchID, UUID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { runExecutorCommand, spawnExecutor } from '../utils/spawn-executor.js';
import { BranchesService } from './branches';

vi.mock('../utils/spawn-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/spawn-executor.js')>();
  return {
    ...actual,
    spawnExecutor: vi.fn(),
    runExecutorCommand: vi.fn(),
    getDaemonUrl: vi.fn(() => 'http://daemon.test'),
  };
});

function createTenantScopeTestDb() {
  return { run: vi.fn() };
}

function createRenderEnvHarness(opts: {
  current: string | null;
  status: 'running' | 'starting' | 'stopped';
}) {
  const reposGet = vi.fn(async () => ({
    repo_id: 'repo-1',
    slug: 'org/repo',
    environment: {
      version: 2,
      default: 'dev',
      variants: {
        dev: { start: 'echo dev', stop: 'echo stop' },
        e2e: { start: 'echo e2e', stop: 'echo stop' },
      },
    },
  }));
  const app = {
    sessionTokenService: {
      generateToken: vi.fn(async () => 'executor-token'),
    },
    service(path: string) {
      if (path === 'repos') return { get: reposGet };
      throw new Error(`Unknown service: ${path}`);
    },
  } as unknown as Application;
  const service = new BranchesService(createTenantScopeTestDb() as never, app);
  // Bypass the auth gate (it would otherwise call loadConfig); the running
  // guard fires after auth and is what we're testing here.
  vi.spyOn(service as never, 'ensureCanTriggerEnv').mockResolvedValue(undefined as never);
  vi.spyOn(service, 'get').mockResolvedValue({
    branch_id: 'wt-1',
    repo_id: 'repo-1',
    name: 'wt-1',
    path: '/tmp/wt-1',
    branch_unique_id: 1,
    environment_variant: opts.current,
    environment_instance: { status: opts.status },
  } as never);
  // patch should NEVER be reached when the guard fires; spying lets the test
  // assert that.
  const patchSpy = vi.spyOn(service, 'patch').mockResolvedValue({} as never);
  return { service, reposGet, patchSpy };
}

function createPatchHarness(opts: {
  current: Record<string, unknown>;
  updated: Record<string, unknown>;
}) {
  const boardObjectsService = {
    find: vi.fn(async () => ({ data: [] })),
    findByBranchId: vi.fn(async () => null),
    create: vi.fn(async () => ({ object_id: 'obj-1' })),
    remove: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
  };
  const boardsService = {
    get: vi.fn(async () => ({ objects: {} })),
    emit: vi.fn(),
  };
  const branchesFindService = {
    find: vi.fn(async () => []),
  };
  const app = {
    sessionTokenService: {
      generateToken: vi.fn(async () => 'executor-token'),
    },
    service(path: string) {
      if (path === 'board-objects') return boardObjectsService;
      if (path === 'boards') return boardsService;
      if (path === 'branches') return branchesFindService;
      throw new Error(`Unknown service: ${path}`);
    },
  } as unknown as Application;

  const branchId = opts.current.branch_id as BranchID;
  const repository = {
    findById: vi.fn(async () => opts.current),
    update: vi.fn(async () => opts.updated),
    create: vi.fn(),
    findAll: vi.fn(async () => []),
    delete: vi.fn(),
  };
  const boardRepo = {
    clearPrimaryTeammateIfMatches: vi.fn(async () => ({
      board_id: opts.current.board_id,
      primary_teammate_id: undefined,
    })),
    setPrimaryTeammateIfUnset: vi.fn(async () => ({
      board_id: opts.updated.board_id,
      primary_teammate_id: branchId,
    })),
  };
  Object.assign(boardRepo, {
    clearPrimaryTeammateIfMatches: boardRepo.clearPrimaryTeammateIfMatches,
    setPrimaryTeammateIfUnset: boardRepo.setPrimaryTeammateIfUnset,
  });
  const service = new BranchesService(createTenantScopeTestDb() as never, app);
  (service as unknown as { repository: typeof repository }).repository = repository;
  (service as unknown as { boardRepo: typeof boardRepo }).boardRepo = boardRepo;
  (service as unknown as { branchRepo: { enrichWithZoneInfo: typeof vi.fn } }).branchRepo = {
    enrichWithZoneInfo: vi.fn(async (branch) => branch),
  } as never;
  vi.spyOn(service as never, 'computeDefaultBoardPositionForBranch').mockResolvedValue({
    x: 10,
    y: 20,
  });

  return { service, repository, boardRepo, boardObjectsService, boardsService, branchId };
}

const teammateContext = {
  teammate: {
    kind: 'teammate',
    displayName: 'Teammate',
  },
};

function createServiceHarness() {
  const boardObjectsService = {
    find: vi.fn(async () => ({ data: [] })),
    findByBranchId: vi.fn(async () => null),
    create: vi.fn(async () => ({ object_id: 'obj-1' })),
    remove: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
  };

  const sessionsService = {
    find: vi.fn(async () => []),
    patch: vi.fn(async () => ({})),
  };

  const reposService = {
    get: vi.fn(async () => ({ repo_id: 'repo-1', local_path: '/tmp/repo', unix_group: null })),
  };

  // The `branches` self-reference is used by updateEnvironment to manually
  // emit the `patched` event (this.patch bypasses Feathers auto-dispatch).
  const branchesService = { find: vi.fn(async () => []), emit: vi.fn() };

  const app = {
    sessionTokenService: {
      generateToken: vi.fn(async () => 'executor-token'),
    },
    service(path: string) {
      if (path === 'board-objects') return boardObjectsService;
      if (path === 'sessions') return sessionsService;
      if (path === 'boards') return { get: vi.fn(async () => ({ objects: {} })) };
      if (path === 'branches') return branchesService;
      if (path === 'repos') return reposService;
      throw new Error(`Unknown service: ${path}`);
    },
  } as unknown as Application;

  const service = new BranchesService(createTenantScopeTestDb() as never, app);
  return { service, boardObjectsService, sessionsService, branchesService };
}

async function runInTestTenantScope<T>(work: () => Promise<T>): Promise<T> {
  return runWithTenantDatabaseScope(createTenantScopeTestDb() as never, 'tenant-test', work);
}

function waitForDeferredWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const mockedSpawnExecutor = vi.mocked(spawnExecutor);
const mockedRunExecutorCommand = vi.mocked(runExecutorCommand);

beforeEach(() => {
  mockedSpawnExecutor.mockReset();
  mockedRunExecutorCommand.mockReset();
});

function createFindHarness(opts: {
  branches: Array<Record<string, unknown>>;
  branchIdsInZone: BranchID[];
}) {
  const app = {
    service(path: string) {
      throw new Error(`Unknown service: ${path}`);
    },
  } as unknown as Application;
  // Faithfully simulate the SQL pushdown performed by BranchRepository.findAll:
  // narrow the candidate rows by the predicates fetchData hands the repository.
  // DrizzleService.find still re-applies every query filter in memory, so the
  // returned set only needs to match what the real WHERE clause would select.
  const applyFilter = (filter?: {
    repo_id?: string;
    board_id?: string;
    archived?: boolean;
    branchIds?: BranchID[];
    visibleToUserId?: string;
  }) =>
    opts.branches.filter((branch) => {
      if (filter?.repo_id !== undefined && branch.repo_id !== filter.repo_id) return false;
      if (filter?.board_id !== undefined && branch.board_id !== filter.board_id) return false;
      if (filter?.archived !== undefined && Boolean(branch.archived) !== filter.archived)
        return false;
      if (
        filter?.branchIds !== undefined &&
        !filter.branchIds.includes(branch.branch_id as BranchID)
      )
        return false;
      return true;
    });
  const repository = {
    findAll: vi.fn(async () => opts.branches),
    findById: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  };
  const branchRepo = {
    findAll: vi.fn(async (filter?: Parameters<typeof applyFilter>[0]) => applyFilter(filter)),
    findBranchIdsByZone: vi.fn(async () => opts.branchIdsInZone),
    enrichManyWithZoneInfo: vi.fn(async (branches: Array<Record<string, unknown>>) =>
      branches.map((branch: Record<string, unknown>) => ({
        ...branch,
        zone_id: opts.branchIdsInZone.includes(branch.branch_id as BranchID)
          ? 'zone-review'
          : undefined,
      }))
    ),
  };
  const service = new BranchesService(createTenantScopeTestDb() as never, app);
  (service as unknown as { repository: typeof repository }).repository = repository;
  (service as unknown as { branchRepo: typeof branchRepo }).branchRepo = branchRepo;

  return { service, repository, branchRepo };
}

describe('BranchesService environment start async behavior', () => {
  function createStartHarness() {
    const { service } = createServiceHarness();
    const branch = {
      branch_id: 'wt-start' as BranchID,
      repo_id: 'repo-1',
      name: 'wt-start',
      path: '/tmp/wt-start',
      created_by: 'user-1' as UUID,
      branch_unique_id: 1,
      start_command: 'docker compose up -d --build',
      app_url: 'http://localhost:3000',
      environment_instance: { status: 'stopped' },
    };

    let currentEnvironment: Record<string, unknown> = { ...branch.environment_instance };
    vi.spyOn(service as never, 'ensureCanTriggerEnv').mockResolvedValue(undefined as never);
    vi.spyOn(service, 'get').mockImplementation(async () => {
      return { ...branch, environment_instance: currentEnvironment } as never;
    });
    vi.spyOn(service as never, 'resolveEnvironmentCommand').mockResolvedValue({
      kind: 'shell',
      command: branch.start_command,
    } as never);
    vi.spyOn(service as never, 'resolveEnvironmentExecutorContext').mockResolvedValue({
      env: { PATH: '/usr/bin:/bin' },
      asUser: undefined,
    } as never);

    const environmentUpdates: Array<Record<string, unknown>> = [];
    vi.spyOn(service, 'updateEnvironment').mockImplementation(async (_id, update) => {
      environmentUpdates.push(update as Record<string, unknown>);
      currentEnvironment = {
        ...currentEnvironment,
        ...update,
      };
      return {
        ...branch,
        environment_instance: currentEnvironment,
      } as never;
    });

    return { service, branch, environmentUpdates };
  }

  it('returns after dispatching shell start commands to the executor', async () => {
    const { service, branch, environmentUpdates } = createStartHarness();

    const result = await Promise.race([
      runInTestTenantScope(() => service.startEnvironment(branch.branch_id)),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);

    expect(result).not.toBe('timed-out');
    expect(mockedSpawnExecutor).not.toHaveBeenCalled();

    await waitForDeferredWork();

    expect(mockedSpawnExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'environment.lifecycle',
        sessionToken: 'executor-token',
        daemonUrl: 'http://daemon.test',
        env: { PATH: '/usr/bin:/bin' },
        params: expect.objectContaining({
          action: 'start',
          branchId: branch.branch_id,
          branchPath: branch.path,
          startCommand: branch.start_command,
          appUrl: branch.app_url,
        }),
      }),
      expect.objectContaining({
        logPrefix: `[Environment.start ${branch.name}]`,
        preparedEnv: { PATH: '/usr/bin:/bin' },
      })
    );
    expect(environmentUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'starting',
          last_error: undefined,
          access_urls: [{ name: 'App', url: 'http://localhost:3000' }],
        }),
      ])
    );
  });

  it('preserves daemon stop fallback when restarting a running shell env without stop command', async () => {
    const { service } = createServiceHarness();
    const kill = vi.fn();
    const branch = {
      branch_id: 'wt-restart-no-stop' as BranchID,
      repo_id: 'repo-1',
      name: 'wt-restart-no-stop',
      path: '/tmp/wt-restart-no-stop',
      created_by: 'user-1' as UUID,
      branch_unique_id: 1,
      start_command: 'docker compose up -d --build',
      app_url: 'http://localhost:3000',
      environment_instance: { status: 'running' },
    };

    let currentEnvironment: Record<string, unknown> = { ...branch.environment_instance };
    vi.spyOn(service as never, 'ensureCanTriggerEnv').mockResolvedValue(undefined as never);
    vi.spyOn(service, 'get').mockImplementation(async () => {
      return { ...branch, environment_instance: currentEnvironment } as never;
    });
    vi.spyOn(service as never, 'resolveEnvironmentCommand').mockResolvedValue({
      kind: 'shell',
      command: branch.start_command,
    } as never);
    vi.spyOn(service as never, 'resolveEnvironmentExecutorContext').mockResolvedValue({
      env: { PATH: '/usr/bin:/bin' },
      asUser: undefined,
    } as never);
    vi.spyOn(service, 'updateEnvironment').mockImplementation(async (_id, update) => {
      currentEnvironment = {
        ...currentEnvironment,
        ...(update as Record<string, unknown>),
      };
      return { ...branch, environment_instance: currentEnvironment } as never;
    });

    (
      service as unknown as { processes: Map<BranchID, { process: { kill: () => void } }> }
    ).processes.set(branch.branch_id, { process: { kill } });

    await runInTestTenantScope(() => service.restartEnvironment(branch.branch_id));

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockedSpawnExecutor).not.toHaveBeenCalled();

    await waitForDeferredWork();

    expect(mockedSpawnExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'environment.lifecycle',
        params: expect.objectContaining({
          action: 'start',
          branchId: branch.branch_id,
          startCommand: branch.start_command,
        }),
      }),
      expect.objectContaining({ logPrefix: `[Environment.start ${branch.name}]` })
    );
    expect(mockedSpawnExecutor).not.toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ action: 'restart' }),
      }),
      expect.anything()
    );
  });

  it('waits for shell stop before webhook start during mixed-mode restart', async () => {
    const { service } = createServiceHarness();
    const branch = {
      branch_id: 'wt-restart-mixed' as BranchID,
      repo_id: 'repo-1',
      name: 'wt-restart-mixed',
      path: '/tmp/wt-restart-mixed',
      created_by: 'user-1' as UUID,
      branch_unique_id: 1,
      start_command: 'https://env.example/start',
      stop_command: 'docker compose down',
      app_url: 'http://localhost:3000',
      environment_instance: { status: 'running' },
    };

    let currentEnvironment: Record<string, unknown> = { ...branch.environment_instance };
    vi.spyOn(service as never, 'ensureCanTriggerEnv').mockResolvedValue(undefined as never);
    vi.spyOn(service, 'get').mockImplementation(async () => {
      return { ...branch, environment_instance: currentEnvironment } as never;
    });
    vi.spyOn(service as never, 'resolveEnvironmentCommand').mockImplementation(
      async (command: string) =>
        command.startsWith('https://')
          ? ({ kind: 'webhook', url: command } as never)
          : ({ kind: 'shell', command } as never)
    );
    vi.spyOn(service as never, 'resolveEnvironmentExecutorContext').mockResolvedValue({
      env: { PATH: '/usr/bin:/bin' },
      asUser: undefined,
    } as never);
    const executeWebhookSpy = vi
      .spyOn(service as never, 'executeEnvironmentWebhook')
      .mockResolvedValue({
        body: 'ok',
        truncated: false,
        status: 200,
      } as never);
    vi.spyOn(service, 'updateEnvironment').mockImplementation(async (_id, update) => {
      currentEnvironment = {
        ...currentEnvironment,
        ...(update as Record<string, unknown>),
      };
      return { ...branch, environment_instance: currentEnvironment } as never;
    });
    mockedRunExecutorCommand.mockResolvedValue({
      success: true,
      data: { branchId: branch.branch_id, action: 'stop' },
    });

    await service.restartEnvironment(branch.branch_id);

    expect(mockedRunExecutorCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'environment.lifecycle',
        params: expect.objectContaining({
          action: 'stop',
          branchId: branch.branch_id,
          stopCommand: branch.stop_command,
        }),
      }),
      expect.objectContaining({ logPrefix: `[Environment.stop ${branch.name}]` })
    );
    expect(executeWebhookSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: branch.start_command,
        commandType: 'start',
      })
    );
    expect(mockedSpawnExecutor).not.toHaveBeenCalled();
  });

  it('uses a reusable branch-scoped token when fetching shell logs via executor', async () => {
    const { service } = createServiceHarness();
    const app = (service as unknown as { app: Application }).app as unknown as {
      sessionTokenService: { generateToken: ReturnType<typeof vi.fn> };
    };
    const branch = {
      branch_id: 'wt-logs' as BranchID,
      repo_id: 'repo-1',
      name: 'wt-logs',
      path: '/tmp/wt-logs',
      created_by: 'user-1' as UUID,
      branch_unique_id: 1,
      logs_command: 'docker compose logs --tail=100',
    };

    vi.spyOn(service as never, 'ensureCanTriggerEnv').mockResolvedValue(undefined as never);
    vi.spyOn(service, 'get').mockResolvedValue(branch as never);
    vi.spyOn(service as never, 'resolveEnvironmentCommand').mockResolvedValue({
      kind: 'shell',
      command: branch.logs_command,
    } as never);
    vi.spyOn(service as never, 'resolveEnvironmentExecutorContext').mockResolvedValue({
      env: { PATH: '/usr/bin:/bin' },
      asUser: undefined,
    } as never);
    mockedRunExecutorCommand.mockResolvedValue({
      success: true,
      data: { logs: 'line 1\nline 2', timestamp: '2026-06-19T00:00:00.000Z' },
    });

    await expect(service.getLogs(branch.branch_id)).resolves.toMatchObject({
      logs: 'line 1\nline 2',
    });

    expect(app.sessionTokenService.generateToken).toHaveBeenCalledWith(
      'environment-logs',
      branch.created_by,
      { branchId: branch.branch_id, maxUses: -1 }
    );
    expect(mockedRunExecutorCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'environment.logs',
        sessionToken: 'executor-token',
        daemonUrl: 'http://daemon.test',
        env: { PATH: '/usr/bin:/bin' },
        params: expect.objectContaining({
          branchId: branch.branch_id,
          branchPath: branch.path,
          logsCommand: branch.logs_command,
        }),
      }),
      expect.objectContaining({
        logPrefix: `[Environment.logs ${branch.name}]`,
        timeoutMs: expect.any(Number),
      })
    );
  });

  // The health monitor probes every running env every 5s. updateEnvironment
  // persists each observation timestamp, but broadcasts ONLY when a
  // health-relevant field actually changes. Otherwise every client rebuilds
  // its branch map and re-runs branch-derived subscriptions per probe.
  describe('health-probe change gate', () => {
    function createGateHarness(initialEnv: Record<string, unknown>) {
      const { service, branchesService } = createServiceHarness();
      let currentEnv = initialEnv;
      const branch = {
        branch_id: 'wt-gate' as BranchID,
        repo_id: 'repo-1',
        name: 'wt-gate',
        path: '/tmp/wt-gate',
        created_by: 'user-1' as UUID,
        branch_unique_id: 1,
      };
      vi.spyOn(service, 'get').mockImplementation(
        async () => ({ ...branch, environment_instance: currentEnv }) as never
      );
      const observationUpdateSpy = vi
        .spyOn(
          (
            service as unknown as {
              branchRepo: {
                update: BranchRepository['update'];
              };
            }
          ).branchRepo,
          'update'
        )
        .mockImplementation(async (_id, data) => {
          currentEnv = data.environment_instance as Record<string, unknown>;
          return { ...branch, environment_instance: currentEnv } as never;
        });
      const patchSpy = vi.spyOn(service, 'patch').mockImplementation(async (_id, data) => {
        const next = { ...branch, ...(data as object) };
        currentEnv = (next as { environment_instance: Record<string, unknown> })
          .environment_instance;
        return next as never;
      });
      return { service, branch, patchSpy, observationUpdateSpy, emit: branchesService.emit };
    }

    const healthyEnv = () => ({
      status: 'running',
      process: { pid: 123 },
      last_health_check: {
        timestamp: '2026-01-01T00:00:00.000Z',
        status: 'healthy',
        message: 'HTTP 200',
      },
      access_urls: [{ name: 'App', url: 'http://localhost:5173' }],
    });

    it('persists but does not emit when the re-probe only advances the timestamp', async () => {
      const { service, branch, patchSpy, observationUpdateSpy, emit } = createGateHarness(
        healthyEnv()
      );

      await service.updateEnvironment(branch.branch_id, {
        status: 'running',
        last_health_check: {
          timestamp: '2026-01-01T00:00:05.000Z',
          status: 'healthy',
          message: 'HTTP 200',
        },
      });

      expect(patchSpy).not.toHaveBeenCalled();
      expect(observationUpdateSpy).toHaveBeenCalledWith(
        branch.branch_id,
        {
          environment_instance: expect.objectContaining({
            last_health_check: expect.objectContaining({
              timestamp: '2026-01-01T00:00:05.000Z',
            }),
          }),
        },
        { preserveUpdatedAt: true }
      );
      expect(emit).not.toHaveBeenCalled();
    });

    it('does not broadcast timestamp bookkeeping', async () => {
      const { service, branch, patchSpy, observationUpdateSpy, emit } = createGateHarness(
        healthyEnv()
      );

      // Same status + health status + message; only the bookkeeping timestamp
      // moved. A timestamp must never defeat the change gate.
      await service.updateEnvironment(branch.branch_id, {
        last_health_check: {
          timestamp: '2026-06-30T12:00:00.000Z',
          status: 'healthy',
          message: 'HTTP 200',
        },
      });

      expect(patchSpy).not.toHaveBeenCalled();
      expect(observationUpdateSpy).toHaveBeenCalledTimes(1);
      expect(emit).not.toHaveBeenCalled();
    });

    it('does not write or emit an exactly identical observation', async () => {
      const { service, branch, patchSpy, observationUpdateSpy, emit } = createGateHarness(
        healthyEnv()
      );

      await service.updateEnvironment(branch.branch_id, {
        status: 'running',
        last_health_check: {
          timestamp: '2026-01-01T00:00:00.000Z',
          status: 'healthy',
          message: 'HTTP 200',
        },
      });

      expect(patchSpy).not.toHaveBeenCalled();
      expect(observationUpdateSpy).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('patches and emits exactly once when the health status flips', async () => {
      const { service, branch, patchSpy, emit } = createGateHarness(healthyEnv());

      await service.updateEnvironment(branch.branch_id, {
        last_health_check: {
          timestamp: '2026-01-01T00:00:05.000Z',
          status: 'unhealthy',
          message: 'HTTP 503 Service Unavailable',
        },
      });

      expect(patchSpy).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][0]).toBe('patched');
    });
  });

  it('accepts branch-scoped RPC envelope for updateEnvironment', async () => {
    const { service } = createServiceHarness();
    const branch = {
      branch_id: 'wt-env-rpc' as BranchID,
      repo_id: 'repo-1',
      name: 'wt-env-rpc',
      path: '/tmp/wt-env-rpc',
      created_by: 'user-1' as UUID,
      branch_unique_id: 1,
      environment_instance: {
        status: 'stopping',
        process: { pid: 123 },
        last_health_check: {
          timestamp: '2026-01-01T00:00:00.000Z',
          status: 'healthy',
          message: 'old',
        },
      },
    };
    vi.spyOn(service, 'get').mockResolvedValue(branch as never);
    const patchSpy = vi.spyOn(service, 'patch').mockImplementation(async (_id, data) => {
      return { ...branch, ...(data as object) } as never;
    });

    await service.updateEnvironment({
      branch_id: branch.branch_id,
      environment_update: {
        status: 'stopped',
        // Remote executor calls cross JSON, where undefined is dropped; null is
        // the explicit clear sentinel.
        process: null,
        last_health_check: null,
      },
    });

    const patchedEnvironment = patchSpy.mock.calls[0]?.[1]?.environment_instance as
      | Record<string, unknown>
      | undefined;
    expect(patchedEnvironment).toMatchObject({ status: 'stopped' });
    expect(patchedEnvironment).not.toHaveProperty('process');
    expect(patchedEnvironment).not.toHaveProperty('last_health_check');
    expect(patchSpy).toHaveBeenCalledWith(
      branch.branch_id,
      expect.objectContaining({
        environment_instance: expect.objectContaining({
          status: 'stopped',
        }),
      }),
      undefined
    );
  });

  it('emits patched with a hook-shaped publish context carrying tenant params (regression #1750)', async () => {
    const { service, branchesService } = createServiceHarness();
    const branch = {
      branch_id: 'wt-env-emit' as BranchID,
      repo_id: 'repo-1',
      name: 'wt-env-emit',
      path: '/tmp/wt-env-emit',
      created_by: 'user-1' as UUID,
      branch_unique_id: 1,
      environment_instance: { status: 'starting' },
    };
    vi.spyOn(service, 'get').mockResolvedValue(branch as never);
    vi.spyOn(service, 'patch').mockImplementation(async (_id, data) => {
      return { ...branch, ...(data as object) } as never;
    });

    // Background transitions (health-monitor start→running, executor
    // stop/nuke→stopped) call updateEnvironment with the tenant params. The
    // manual emit MUST forward a HookContext-shaped third arg — Feathers passes
    // it through UNCHANGED as the publish `hook`, so raw params (or nothing)
    // leaves the publish handler without `context.path`/`context.params.tenant`
    // and it suppresses the event to service-only sockets under
    // `mode: required_from_auth`, leaving the env card spinner stuck.
    const params = { tenant: { tenant_id: 'tenant-1', source: 'auth_claim' } };
    await service.updateEnvironment(branch.branch_id, { status: 'running' }, params as never);

    expect(branchesService.emit).toHaveBeenCalledTimes(1);
    const [event, payload, hook] = branchesService.emit.mock.calls[0];
    expect(event).toBe('patched');
    expect(payload).toEqual(
      expect.objectContaining({
        branch_id: branch.branch_id,
        environment_instance: expect.objectContaining({ status: 'running' }),
      })
    );
    // Load-bearing: publish context needs path (branch RBAC scoping) and
    // params.tenant (tenant channel resolution), not raw params.
    expect(hook).toEqual(
      expect.objectContaining({
        path: 'branches',
        event: 'patched',
        id: branch.branch_id,
        params,
      })
    );
  });

  it('clears explicit undefined environment fields for in-process callers', async () => {
    const { service } = createServiceHarness();
    const branch = {
      branch_id: 'wt-env-clear' as BranchID,
      repo_id: 'repo-1',
      name: 'wt-env-clear',
      path: '/tmp/wt-env-clear',
      created_by: 'user-1' as UUID,
      branch_unique_id: 1,
      environment_instance: {
        status: 'error',
        process: { pid: 456 },
        last_error: 'old error',
        last_command: {
          action: 'start',
          status: 'failed',
          message: 'old failure',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    vi.spyOn(service, 'get').mockResolvedValue(branch as never);
    const patchSpy = vi.spyOn(service, 'patch').mockImplementation(async (_id, data) => {
      return { ...branch, ...(data as object) } as never;
    });

    await service.updateEnvironment(branch.branch_id, {
      status: 'starting',
      process: undefined,
      last_error: undefined,
      last_command: undefined,
    });

    const patchedEnvironment = patchSpy.mock.calls[0]?.[1]?.environment_instance as
      | Record<string, unknown>
      | undefined;
    expect(patchedEnvironment).toMatchObject({ status: 'starting' });
    expect(patchedEnvironment).not.toHaveProperty('process');
    expect(patchedEnvironment).not.toHaveProperty('last_error');
    expect(patchedEnvironment).not.toHaveProperty('last_command');
  });
});

describe('BranchesService.patch primary teammate invariants', () => {
  it('clears the old primary and sets the new board primary when a teammate moves boards', async () => {
    const boardA = 'board-a' as BoardID;
    const boardB = 'board-b' as BoardID;
    const branchId = 'teammate-1' as BranchID;
    const { service, boardRepo, boardObjectsService, boardsService } = createPatchHarness({
      current: {
        branch_id: branchId,
        board_id: boardA,
        custom_context: teammateContext,
      },
      updated: {
        branch_id: branchId,
        board_id: boardB,
        custom_context: teammateContext,
      },
    });

    await service.patch(branchId, { board_id: boardB });

    expect(boardRepo.clearPrimaryTeammateIfMatches).toHaveBeenCalledWith(boardA, branchId);
    expect(boardRepo.setPrimaryTeammateIfUnset).toHaveBeenCalledWith(boardB, branchId);
    expect(boardsService.emit).toHaveBeenCalledWith(
      'patched',
      expect.objectContaining({ board_id: boardA }),
      expect.objectContaining({ path: 'boards', method: 'patch', id: boardA })
    );
    expect(boardsService.emit).toHaveBeenCalledWith(
      'patched',
      expect.objectContaining({ board_id: boardB }),
      expect.objectContaining({ path: 'boards', method: 'patch', id: boardB })
    );
    expect(boardObjectsService.create).toHaveBeenCalledWith({
      board_id: boardB,
      branch_id: branchId,
      position: { x: 10, y: 20 },
    });
  });

  it('clears the primary pointer when a teammate is archived in place', async () => {
    const boardId = 'board-a' as BoardID;
    const branchId = 'teammate-archive' as BranchID;
    const { service, boardRepo } = createPatchHarness({
      current: {
        branch_id: branchId,
        board_id: boardId,
        archived: false,
        custom_context: teammateContext,
      },
      updated: {
        branch_id: branchId,
        board_id: boardId,
        archived: true,
        custom_context: teammateContext,
      },
    });

    await service.patch(branchId, { archived: true });

    expect(boardRepo.clearPrimaryTeammateIfMatches).toHaveBeenCalledWith(boardId, branchId);
    expect(boardRepo.setPrimaryTeammateIfUnset).not.toHaveBeenCalled();
  });

  it('preserves the board object zone pin when a branch is archived via patch', async () => {
    const boardId = 'board-a' as BoardID;
    const branchId = 'branch-archive-zone' as BranchID;
    const { service, boardObjectsService } = createPatchHarness({
      current: {
        branch_id: branchId,
        board_id: boardId,
        archived: false,
        custom_context: {},
      },
      updated: {
        branch_id: branchId,
        board_id: boardId,
        archived: true,
        custom_context: {},
      },
    });
    boardObjectsService.findByBranchId.mockResolvedValue({
      object_id: 'obj-branch',
      zone_id: 'zone-review',
    });

    await service.patch(branchId, { archived: true });

    expect(boardObjectsService.findByBranchId).not.toHaveBeenCalled();
    expect(boardObjectsService.patch).not.toHaveBeenCalled();
  });

  it('rejects converting a normal branch into a teammate', async () => {
    const boardId = 'board-a' as BoardID;
    const branchId = 'branch-1' as BranchID;
    const { service, repository } = createPatchHarness({
      current: {
        branch_id: branchId,
        board_id: boardId,
        custom_context: {},
      },
      updated: {
        branch_id: branchId,
        board_id: boardId,
        custom_context: teammateContext,
      },
    });

    await expect(service.patch(branchId, { custom_context: teammateContext })).rejects.toThrow(
      /cannot be converted/i
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('rejects converting a teammate into a normal branch', async () => {
    const boardId = 'board-a' as BoardID;
    const branchId = 'teammate-2' as BranchID;
    const { service, repository } = createPatchHarness({
      current: {
        branch_id: branchId,
        board_id: boardId,
        custom_context: teammateContext,
      },
      updated: {
        branch_id: branchId,
        board_id: boardId,
        custom_context: { teammate: null },
      },
    });

    await expect(service.patch(branchId, { custom_context: { teammate: null } })).rejects.toThrow(
      /cannot be converted/i
    );
    expect(repository.update).not.toHaveBeenCalled();
  });
});

describe('BranchesService one-shot teammate creation wiring', () => {
  // A branch created with teammate metadata on the initial row (the MCP create
  // path and the UI path) must designate the board's primary teammate. This is
  // the promotion that IS supported — as opposed to flipping an existing branch
  // via patch, which the assertTeammateKindIsStable guard (deliberately) blocks.
  function createTeammateWiringHarness() {
    const boardsEmit = vi.fn();
    const app = {
      service(path: string) {
        if (path === 'boards') return { emit: boardsEmit };
        throw new Error(`Unknown service: ${path}`);
      },
    } as unknown as Application;
    const boardRepo = {
      setPrimaryTeammateIfUnset: vi.fn(async (boardId: string) => ({
        board_id: boardId,
        primary_teammate_id: 'teammate-new',
      })),
    };
    const service = new BranchesService(createTenantScopeTestDb() as never, app);
    (service as unknown as { boardRepo: typeof boardRepo }).boardRepo = boardRepo;
    const invoke = (branch: Record<string, unknown>) =>
      (
        service as unknown as {
          maybeSetBoardPrimaryTeammate: (b: unknown) => Promise<void>;
        }
      ).maybeSetBoardPrimaryTeammate(branch);
    return { boardRepo, boardsEmit, invoke };
  }

  it('sets the board primary teammate pointer for a newly created teammate branch', async () => {
    const { boardRepo, boardsEmit, invoke } = createTeammateWiringHarness();

    await invoke({
      branch_id: 'teammate-new' as BranchID,
      board_id: 'board-a' as BoardID,
      custom_context: teammateContext,
    });

    expect(boardRepo.setPrimaryTeammateIfUnset).toHaveBeenCalledWith('board-a', 'teammate-new');
    expect(boardsEmit).toHaveBeenCalledWith(
      'patched',
      expect.objectContaining({ board_id: 'board-a' }),
      expect.objectContaining({ path: 'boards', method: 'patch', id: 'board-a' })
    );
  });

  it('leaves the board primary pointer untouched for a non-teammate branch', async () => {
    const { boardRepo, boardsEmit, invoke } = createTeammateWiringHarness();

    await invoke({
      branch_id: 'plain-new' as BranchID,
      board_id: 'board-a' as BoardID,
      custom_context: {},
    });

    expect(boardRepo.setPrimaryTeammateIfUnset).not.toHaveBeenCalled();
    expect(boardsEmit).not.toHaveBeenCalled();
  });
});

describe('BranchesService.unarchive', () => {
  it('preserves existing board_id when options.boardId is not provided', async () => {
    const { service, boardObjectsService, sessionsService } = createServiceHarness();
    const branchId = 'wt-1' as BranchID;
    const existingBoardId = 'board-a' as BoardID;

    vi.spyOn(service, 'get').mockResolvedValue({
      branch_id: branchId,
      name: 'WT 1',
      path: '/tmp',
      archived: true,
      board_id: existingBoardId,
    } as never);
    const patchSpy = vi.spyOn(service, 'patch').mockResolvedValue({
      branch_id: branchId,
      name: 'WT 1',
      path: '/tmp',
      archived: false,
      board_id: existingBoardId,
    } as never);
    vi.spyOn(service as never, 'computeDefaultBoardPositionForBranch').mockResolvedValue({
      x: 111,
      y: 222,
    });

    await service.unarchive(branchId);

    expect(patchSpy).toHaveBeenCalledWith(
      branchId,
      expect.objectContaining({
        archived: false,
        archived_at: undefined,
        archived_by: undefined,
        filesystem_status: undefined,
      }),
      undefined
    );
    expect(patchSpy.mock.calls[0][1]).not.toHaveProperty('board_id');

    expect(boardObjectsService.findByBranchId).toHaveBeenCalledWith(branchId);
    expect(boardObjectsService.create).toHaveBeenCalledWith({
      board_id: existingBoardId,
      branch_id: branchId,
      position: { x: 111, y: 222 },
    });

    expect(sessionsService.find).toHaveBeenCalledTimes(1);
    expect(sessionsService.patch).not.toHaveBeenCalled();
  });

  it('does not create a new board object when one already exists', async () => {
    const { service, boardObjectsService } = createServiceHarness();
    const branchId = 'wt-2' as BranchID;
    const boardId = 'board-b' as BoardID;

    vi.spyOn(service, 'get').mockResolvedValue({
      branch_id: branchId,
      name: 'WT 2',
      path: '/tmp',
      archived: true,
      board_id: boardId,
    } as never);
    vi.spyOn(service, 'patch').mockResolvedValue({
      branch_id: branchId,
      name: 'WT 2',
      path: '/tmp',
      archived: false,
      board_id: boardId,
    } as never);
    boardObjectsService.findByBranchId.mockResolvedValue({ object_id: 'existing' });

    await service.unarchive(branchId);

    expect(boardObjectsService.findByBranchId).toHaveBeenCalledWith(branchId);
    expect(boardObjectsService.create).not.toHaveBeenCalled();
  });

  it('uses explicit options.boardId override for patch and placement', async () => {
    const { service, boardObjectsService } = createServiceHarness();
    const branchId = 'wt-3' as BranchID;
    const oldBoardId = 'board-old' as BoardID;
    const newBoardId = 'board-new' as BoardID;

    vi.spyOn(service, 'get').mockResolvedValue({
      branch_id: branchId,
      name: 'WT 3',
      path: '/tmp',
      archived: true,
      board_id: oldBoardId,
    } as never);
    const patchSpy = vi.spyOn(service, 'patch').mockResolvedValue({
      branch_id: branchId,
      name: 'WT 3',
      path: '/tmp',
      archived: false,
      board_id: newBoardId,
    } as never);
    vi.spyOn(service as never, 'computeDefaultBoardPositionForBranch').mockResolvedValue({
      x: 7,
      y: 8,
    });

    await service.unarchive(branchId, { boardId: newBoardId });

    expect(patchSpy).toHaveBeenCalledWith(
      branchId,
      expect.objectContaining({
        archived: false,
        board_id: newBoardId,
      }),
      undefined
    );
    expect(boardObjectsService.create).toHaveBeenCalledWith({
      board_id: newBoardId,
      branch_id: branchId,
      position: { x: 7, y: 8 },
    });
  });
});

describe('BranchesService.archiveOrDelete', () => {
  it('preserves a zoned board object when archiving through the archive operation', async () => {
    const { service, boardObjectsService, sessionsService } = createServiceHarness();
    const branchId = 'wt-archive-op' as BranchID;
    const userId = 'user-1' as UUID;

    vi.spyOn(service, 'get').mockResolvedValue({
      branch_id: branchId,
      name: 'WT Archive Op',
      path: '/tmp/wt-archive-op',
      archived: false,
      board_id: 'board-a',
      filesystem_status: 'ready',
      environment_instance: { status: 'stopped' },
    } as never);
    vi.spyOn(service, 'patch').mockResolvedValue({
      branch_id: branchId,
      name: 'WT Archive Op',
      path: '/tmp/wt-archive-op',
      archived: true,
      board_id: 'board-a',
    } as never);
    boardObjectsService.findByBranchId.mockResolvedValue({
      object_id: 'obj-branch',
      zone_id: 'zone-review',
    });

    await service.archiveOrDelete(
      branchId,
      { metadataAction: 'archive', filesystemAction: 'preserved' },
      { user: { user_id: userId } } as never
    );

    expect(sessionsService.find).toHaveBeenCalledWith({
      query: { branch_id: branchId, $limit: 1000 },
      paginate: false,
    });
    expect(boardObjectsService.findByBranchId).not.toHaveBeenCalled();
    expect(boardObjectsService.patch).not.toHaveBeenCalled();
  });
});

describe('BranchesService.find zone filtering', () => {
  it('applies zone_id before pagination', async () => {
    const branch1 = { branch_id: 'branch-1', name: 'outside', board_id: 'board-1' };
    const branch2 = { branch_id: 'branch-2', name: 'inside-a', board_id: 'board-1' };
    const branch3 = { branch_id: 'branch-3', name: 'inside-b', board_id: 'board-1' };
    const { service, branchRepo } = createFindHarness({
      branches: [branch1, branch2, branch3],
      branchIdsInZone: ['branch-2' as BranchID, 'branch-3' as BranchID],
    });

    const result = (await service.find({
      query: { zone_id: 'zone-review', $limit: 1 },
    })) as { data: Array<Record<string, unknown>>; total: number; limit: number; skip: number };

    expect(branchRepo.findBranchIdsByZone).toHaveBeenCalledWith('zone-review');
    expect(result.total).toBe(2);
    expect(result.limit).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].branch_id).toBe('branch-2');
    expect(result.data[0].zone_id).toBe('zone-review');
  });

  it('intersects zone_id filtering with existing branch_id scoping', async () => {
    const branch1 = { branch_id: 'branch-1', name: 'outside', board_id: 'board-1' };
    const branch2 = { branch_id: 'branch-2', name: 'inside-a', board_id: 'board-1' };
    const branch3 = { branch_id: 'branch-3', name: 'inside-b', board_id: 'board-1' };
    const { service } = createFindHarness({
      branches: [branch1, branch2, branch3],
      branchIdsInZone: ['branch-2' as BranchID, 'branch-3' as BranchID],
    });

    const result = (await service.find({
      query: {
        zone_id: 'zone-review',
        branch_id: { $in: ['branch-3' as BranchID] },
      },
    })) as { data: Array<Record<string, unknown>>; total: number };

    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].branch_id).toBe('branch-3');
  });
});

describe('BranchesService.find SQL pushdown', () => {
  // Mixed fixture: two boards, archived + active rows, so a whole-table read
  // would over-fetch relative to a board+archived scoped query.
  const fixture = () => [
    { branch_id: 'b1', name: 'beta', board_id: 'board-1', archived: false },
    { branch_id: 'b2', name: 'alpha', board_id: 'board-1', archived: false },
    { branch_id: 'b3', name: 'gamma', board_id: 'board-1', archived: true },
    { branch_id: 'b4', name: 'delta', board_id: 'board-2', archived: false },
  ];

  it('pushes board_id + archived into the repository read and never reads the whole table (rbac off)', async () => {
    const { service, repository, branchRepo } = createFindHarness({
      branches: fixture(),
      branchIdsInZone: [],
    });

    const result = (await service.find({
      query: { board_id: 'board-1', archived: false, $sort: { name: 1 } },
    })) as { data: Array<Record<string, unknown>>; total: number };

    // Read is SQL-bounded: the scoped repo read runs, the whole-table read does not.
    expect(branchRepo.findAll).toHaveBeenCalledWith({ board_id: 'board-1', archived: false });
    expect(repository.findAll).not.toHaveBeenCalled();

    // Parity: same rows the JS filter would keep, same order, same total + zone enrichment.
    expect(result.total).toBe(2);
    expect(result.data.map((b) => b.branch_id)).toEqual(['b2', 'b1']);
    expect(result.data.every((b) => 'zone_id' in b)).toBe(true);
  });

  it('pushes an accessible branch_id $in set alongside board_id + archived (rbac on)', async () => {
    const { service, repository, branchRepo } = createFindHarness({
      branches: fixture(),
      branchIdsInZone: [],
    });

    const result = (await service.find({
      query: {
        board_id: 'board-1',
        archived: false,
        branch_id: { $in: ['b1' as BranchID, 'b3' as BranchID, 'b4' as BranchID] },
      },
    })) as { data: Array<Record<string, unknown>>; total: number };

    expect(branchRepo.findAll).toHaveBeenCalledWith({
      board_id: 'board-1',
      archived: false,
      branchIds: ['b1', 'b3', 'b4'],
    });
    expect(repository.findAll).not.toHaveBeenCalled();

    // b3 is archived, b4 is on board-2 → only b1 survives the intersection.
    expect(result.total).toBe(1);
    expect(result.data.map((b) => b.branch_id)).toEqual(['b1']);
  });

  it('pushes a scalar branch_id as a single-id set', async () => {
    const { service, branchRepo } = createFindHarness({
      branches: fixture(),
      branchIdsInZone: [],
    });

    const result = (await service.find({
      query: { branch_id: 'b2' as BranchID },
    })) as { data: Array<Record<string, unknown>>; total: number };

    expect(branchRepo.findAll).toHaveBeenCalledWith({ branchIds: ['b2'] });
    expect(result.total).toBe(1);
    expect(result.data[0].branch_id).toBe('b2');
  });

  it('returns no rows for an empty accessible set without reading the table', async () => {
    const { service, branchRepo } = createFindHarness({
      branches: fixture(),
      branchIdsInZone: [],
    });

    const result = (await service.find({
      query: { branch_id: { $in: [] } },
    })) as { data: Array<Record<string, unknown>>; total: number };

    expect(branchRepo.findAll).toHaveBeenCalledWith({ branchIds: [] });
    expect(result.total).toBe(0);
    expect(result.data).toHaveLength(0);
  });

  it('pushes the RBAC SQL visibility marker into the repository read', async () => {
    const { service, branchRepo } = createFindHarness({
      branches: fixture(),
      branchIdsInZone: [],
    });

    await service.find({
      _agorSqlBranchAccessUserId: 'viewer-1' as UUID,
      query: { board_id: 'board-1' },
    } as BranchParams);

    expect(branchRepo.findAll).toHaveBeenCalledWith({
      board_id: 'board-1',
      visibleToUserId: 'viewer-1',
    });
  });
});

describe('BranchesService.renderEnvironment running-guard', () => {
  it('throws when caller requests a different variant while env is running', async () => {
    const { service, patchSpy } = createRenderEnvHarness({
      current: 'dev',
      status: 'running',
    });

    await expect(service.renderEnvironment('wt-1' as BranchID, { variant: 'e2e' })).rejects.toThrow(
      /Cannot change environment variant to "e2e" while the environment is running/
    );
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('throws when caller requests a different variant while env is starting', async () => {
    const { service, patchSpy } = createRenderEnvHarness({
      current: 'dev',
      status: 'starting',
    });

    await expect(service.renderEnvironment('wt-1' as BranchID, { variant: 'e2e' })).rejects.toThrow(
      /Cannot change environment variant to "e2e" while the environment is starting/
    );
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('error message includes the currently-configured variant for debuggability', async () => {
    const { service } = createRenderEnvHarness({
      current: 'dev',
      status: 'running',
    });

    await expect(service.renderEnvironment('wt-1' as BranchID, { variant: 'e2e' })).rejects.toThrow(
      /currently configured for "dev"/
    );
  });
});

describe('BranchesService managed environment control authorization', () => {
  const branchId = 'wt-auth' as BranchID;
  const allUserId = 'user-all';
  const otherId = 'user-other';

  function paramsFor(
    user_id: string,
    role: 'viewer' | 'member' | 'admin' | 'superadmin' = 'member'
  ) {
    return {
      provider: 'rest',
      user: { user_id, role },
    } as never;
  }

  function createAuthHarness(
    effectivePermission: 'all' | 'prompt' | 'session' | 'view' = 'session'
  ) {
    const { service } = createServiceHarness();
    const branch = {
      branch_id: branchId,
      repo_id: 'repo-1',
      name: 'wt-auth',
      path: '/tmp/wt-auth',
      branch_unique_id: 1,
      environment_instance: { status: 'stopped' },
    };
    const branchRepo = {
      findById: vi.fn(async () => branch),
      resolveUserPermission: vi.fn(async () => effectivePermission),
    };
    (service as unknown as { branchRepo: typeof branchRepo }).branchRepo = branchRepo;
    const getSpy = vi.spyOn(service, 'get').mockResolvedValue(branch as never);
    return { service, branchRepo, getSpy };
  }

  it('denies non-owner members before starting an environment', async () => {
    const { service, getSpy } = createAuthHarness('session');

    await expect(service.startEnvironment(branchId, paramsFor(otherId, 'member'))).rejects.toThrow(
      /'all' branch permission or admin access/
    );
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('allows users with effective all permission through the control gate', async () => {
    const { service } = createAuthHarness('all');

    await expect(
      service.startEnvironment(branchId, paramsFor(allUserId, 'member'))
    ).rejects.toThrow(/No start command configured/);
  });

  it('allows admins and superadmins through the control gate', async () => {
    const adminHarness = createAuthHarness('session');
    await expect(
      adminHarness.service.startEnvironment(branchId, paramsFor(otherId, 'admin'))
    ).rejects.toThrow(/No start command configured/);
    expect(adminHarness.branchRepo.findById).not.toHaveBeenCalled();

    const superHarness = createAuthHarness('session');
    await expect(
      superHarness.service.startEnvironment(branchId, paramsFor(otherId, 'superadmin'))
    ).rejects.toThrow(/No start command configured/);
    expect(superHarness.branchRepo.findById).not.toHaveBeenCalled();
  });

  it('denies non-owner members before rendering environment commands', async () => {
    const { service, getSpy } = createAuthHarness('session');

    await expect(
      service.renderEnvironment(branchId, { variant: 'dev' }, paramsFor(otherId, 'member'))
    ).rejects.toThrow(/'all' branch permission or admin access/);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('allows users with effective all permission through the render control gate', async () => {
    const { service } = createAuthHarness('all');

    await expect(
      service.renderEnvironment(branchId, { variant: 'dev' }, paramsFor(allUserId, 'member'))
    ).rejects.toThrow(/Repo has no v2 environment config/);
  });

  it('keeps health checks available without the control gate', async () => {
    const { service, branchRepo } = createAuthHarness('session');

    await expect(
      service.checkHealth(branchId, paramsFor(otherId, 'viewer'))
    ).resolves.toMatchObject({
      branch_id: branchId,
    });
    expect(branchRepo.findById).not.toHaveBeenCalled();
  });

  dbTest('allows a group grant with effective all to start/stop environments', async ({ db }) => {
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const branches = new BranchRepository(db);
    const groups = new GroupRepository(db);

    const owner = await users.create({
      email: 'env-owner@example.com',
      name: 'Env Owner',
      role: 'member',
    });
    const member = await users.create({
      email: 'env-group-all@example.com',
      name: 'Env Group All',
      role: 'member',
    });
    const repo = await repos.create({
      name: 'env-rbac-repo',
      slug: 'env-rbac-repo',
      repo_type: 'local',
      local_path: '/tmp/env-rbac-repo',
      default_branch: 'main',
    });
    const branch = await branches.create({
      branch_id: '019f0000-0000-7000-8000-00000000e001' as BranchID,
      repo_id: repo.repo_id,
      name: 'env-group-all',
      ref: 'env-group-all',
      path: '/tmp/env-rbac-repo/env-group-all',
      created_by: owner.user_id as UUID,
      branch_unique_id: 9001,
      new_branch: true,
      others_can: 'none',
    });
    const group = await groups.create({ name: 'Env Controllers', created_by: owner.user_id });
    await groups.addMember(group.group_id, member.user_id, owner.user_id);
    await groups.upsertBranchGrant({
      branch_id: branch.branch_id,
      group_id: group.group_id,
      can: 'all',
      created_by: owner.user_id,
    });

    const service = new BranchesService(db, { service: vi.fn() } as unknown as Application);
    const getSpy = vi.spyOn(service, 'get').mockResolvedValue(branch as never);
    const updateEnvironmentSpy = vi
      .spyOn(service, 'updateEnvironment')
      .mockResolvedValue(branch as never);

    await expect(
      service.startEnvironment(branch.branch_id, paramsFor(member.user_id, 'member'))
    ).rejects.toThrow(/No start command configured/);
    expect(getSpy).toHaveBeenCalled();

    getSpy.mockClear();
    await expect(
      service.stopEnvironment(branch.branch_id, paramsFor(member.user_id, 'member'))
    ).resolves.toMatchObject({ branch_id: branch.branch_id });
    expect(getSpy).toHaveBeenCalled();
    expect(updateEnvironmentSpy).toHaveBeenCalled();
  });

  dbTest('allows direct owners to start environments', async ({ db }) => {
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const branches = new BranchRepository(db);

    const owner = await users.create({
      email: 'env-direct-owner@example.com',
      name: 'Env Direct Owner',
      role: 'member',
    });
    const repo = await repos.create({
      name: 'env-direct-owner-repo',
      slug: 'env-direct-owner-repo',
      repo_type: 'local',
      local_path: '/tmp/env-direct-owner-repo',
      default_branch: 'main',
    });
    const branch = await branches.create({
      branch_id: '019f0000-0000-7000-8000-00000000e002' as BranchID,
      repo_id: repo.repo_id,
      name: 'env-direct-owner',
      ref: 'env-direct-owner',
      path: '/tmp/env-direct-owner-repo/env-direct-owner',
      created_by: owner.user_id as UUID,
      branch_unique_id: 9002,
      new_branch: true,
      others_can: 'none',
    });
    await branches.addOwner(branch.branch_id, owner.user_id as UUID);

    const service = new BranchesService(db, { service: vi.fn() } as unknown as Application);
    vi.spyOn(service, 'get').mockResolvedValue(branch as never);

    await expect(
      service.startEnvironment(branch.branch_id, paramsFor(owner.user_id, 'member'))
    ).rejects.toThrow(/No start command configured/);
  });

  dbTest('rejects insufficient group grants before environment actions run', async ({ db }) => {
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const branches = new BranchRepository(db);
    const groups = new GroupRepository(db);

    const owner = await users.create({
      email: 'env-owner-view@example.com',
      name: 'Env Owner View',
      role: 'member',
    });
    const member = await users.create({
      email: 'env-group-view@example.com',
      name: 'Env Group View',
      role: 'member',
    });
    const repo = await repos.create({
      name: 'env-rbac-view-repo',
      slug: 'env-rbac-view-repo',
      repo_type: 'local',
      local_path: '/tmp/env-rbac-view-repo',
      default_branch: 'main',
    });
    const branch = await branches.create({
      branch_id: '019f0000-0000-7000-8000-00000000e003' as BranchID,
      repo_id: repo.repo_id,
      name: 'env-group-view',
      ref: 'env-group-view',
      path: '/tmp/env-rbac-view-repo/env-group-view',
      created_by: owner.user_id as UUID,
      branch_unique_id: 9003,
      new_branch: true,
      others_can: 'none',
    });
    const group = await groups.create({ name: 'Env Viewers', created_by: owner.user_id });
    await groups.addMember(group.group_id, member.user_id, owner.user_id);
    await groups.upsertBranchGrant({
      branch_id: branch.branch_id,
      group_id: group.group_id,
      can: 'prompt',
      created_by: owner.user_id,
    });

    const service = new BranchesService(db, { service: vi.fn() } as unknown as Application);
    const getSpy = vi.spyOn(service, 'get').mockResolvedValue(branch as never);

    await expect(
      service.startEnvironment(branch.branch_id, paramsFor(member.user_id, 'member'))
    ).rejects.toThrow(/'all' branch permission or admin access/);
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe('BranchesService teammate home Knowledge namespace guard', () => {
  async function createTeammateKbHarness(db: Database) {
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const branches = new BranchRepository(db);
    const namespaces = new KnowledgeNamespaceRepository(db);

    const owner = await users.create({
      email: 'teammate-kb-owner@example.com',
      name: 'Teammate KB Owner',
      role: 'member',
    });
    const namespaceOwner = await users.create({
      email: 'teammate-kb-namespace-owner@example.com',
      name: 'Teammate KB Namespace Owner',
      role: 'member',
    });
    const repo = await repos.create({
      name: 'teammate-kb-repo',
      slug: 'teammate-kb-repo',
      repo_type: 'local',
      local_path: '/tmp/teammate-kb-repo',
      default_branch: 'main',
    });

    const currentNamespace = await namespaces.create({
      slug: 'teammate-current-home',
      display_name: 'Teammate Current Home',
      owner_user_id: namespaceOwner.user_id,
      others_can: 'read',
    });
    const branch = await branches.create({
      branch_id: '019f0000-0000-7000-8000-00000000e101' as BranchID,
      repo_id: repo.repo_id,
      name: 'teammate-kb',
      ref: 'teammate-kb',
      path: '/tmp/teammate-kb-repo/teammate-kb',
      created_by: owner.user_id as UUID,
      branch_unique_id: 9101,
      new_branch: true,
      custom_context: {
        teammate: {
          kind: 'teammate',
          displayName: 'Teammate KB',
          kb: {
            primary_namespace_id: currentNamespace.namespace_id,
            primary_namespace_slug: currentNamespace.slug,
            memory_path_template: 'memory/{{YYYY-MM-DD}}.md',
            default_visibility: currentNamespace.visibility_default,
            global_access: 'write',
            grants: [],
          },
        },
      },
    });

    const app = {
      service(path: string) {
        if (path === 'branches') return { find: vi.fn(async () => []) };
        throw new Error(`Unknown service: ${path}`);
      },
    } as unknown as Application;

    return {
      owner,
      namespaceOwner,
      branch,
      namespaces,
      service: new BranchesService(db, app),
      params: { provider: 'rest', user: owner } as never,
    };
  }

  function homeNamespacePatch(namespaceId: string, namespaceSlug: string) {
    return {
      custom_context: {
        teammate: {
          kb: {
            primary_namespace_id: namespaceId,
            primary_namespace_slug: namespaceSlug,
            memory_path_template: 'memory/{{YYYY-MM-DD}}.md',
            default_visibility: 'public',
            global_access: 'write',
            grants: [],
          },
        },
      },
    };
  }

  dbTest('allows saving policy when the home namespace is unchanged', async ({ db }) => {
    const { branch, service, params } = await createTeammateKbHarness(db);
    const currentKb = (
      branch.custom_context?.teammate as
        | { kb?: { primary_namespace_id?: string; primary_namespace_slug?: string } }
        | undefined
    )?.kb;

    await expect(
      service.patch(
        branch.branch_id,
        {
          custom_context: {
            teammate: {
              kb: {
                primary_namespace_id: currentKb?.primary_namespace_id,
                primary_namespace_slug: currentKb?.primary_namespace_slug,
                memory_path_template: 'memory/{{YYYY-MM-DD}}.md',
                default_visibility: 'public',
                global_access: 'read',
                grants: [],
              },
            },
          },
        } as never,
        params
      )
    ).resolves.toMatchObject({ branch_id: branch.branch_id });
  });

  dbTest('rejects changing home namespace to a namespace without write access', async ({ db }) => {
    const { branch, namespaceOwner, namespaces, service, params } =
      await createTeammateKbHarness(db);
    const readOnly = await namespaces.create({
      slug: 'teammate-read-only-home',
      display_name: 'Teammate Read Only Home',
      owner_user_id: namespaceOwner.user_id,
      others_can: 'read',
    });

    await expect(
      service.patch(
        branch.branch_id,
        homeNamespacePatch(readOnly.namespace_id, readOnly.slug) as never,
        params
      )
    ).rejects.toThrow(/write access/);
  });

  dbTest('rejects changing home namespace when ID and slug disagree', async ({ db }) => {
    const { branch, namespaces, service, params } = await createTeammateKbHarness(db);
    const writable = await namespaces.create({
      slug: 'teammate-writable-home',
      display_name: 'Teammate Writable Home',
      others_can: 'write',
    });

    await expect(
      service.patch(
        branch.branch_id,
        homeNamespacePatch(writable.namespace_id, 'wrong-slug') as never,
        params
      )
    ).rejects.toThrow(/slug does not match/);
  });

  dbTest('allows changing home namespace to a writable namespace', async ({ db }) => {
    const { branch, namespaces, service, params } = await createTeammateKbHarness(db);
    const writable = await namespaces.create({
      slug: 'teammate-writable-home-ok',
      display_name: 'Teammate Writable Home OK',
      others_can: 'write',
    });

    await expect(
      service.patch(
        branch.branch_id,
        homeNamespacePatch(writable.namespace_id, writable.slug) as never,
        params
      )
    ).resolves.toMatchObject({
      custom_context: {
        teammate: {
          kb: {
            primary_namespace_id: writable.namespace_id,
            primary_namespace_slug: writable.slug,
          },
        },
      },
    });
  });
});

describe('BranchesService.create permission defaults', () => {
  dbTest(
    'defaults new board branches to board permissions when no explicit branch permissions are provided',
    async ({ db }) => {
      const users = new UsersRepository(db);
      const repos = new RepoRepository(db);
      const boards = new BoardRepository(db);
      const owner = await users.create({
        email: 'board-default-owner@example.com',
        role: 'member',
      });
      const repo = await repos.create({
        name: 'board-default-repo',
        slug: 'board-default-repo',
        repo_type: 'local',
        local_path: '/tmp/board-default-repo',
        default_branch: 'main',
      });
      const board = await boards.create({
        name: 'Board Defaults',
        created_by: owner.user_id,
        default_others_can: 'prompt',
        default_others_fs_access: 'write',
        default_dangerously_allow_session_sharing: true,
      });

      const app = { service: vi.fn() } as unknown as Application;
      const service = new BranchesService(db, app);
      const branch = (await service.create({
        repo_id: repo.repo_id,
        name: 'board-aligned',
        ref: 'board-aligned',
        path: '/tmp/board-default-repo/board-aligned',
        board_id: board.board_id as BoardID,
        created_by: owner.user_id as UUID,
        branch_unique_id: 9301,
        new_branch: true,
      })) as import('@agor/core/types').Branch;

      expect(branch.permission_source).toBe('board');
      expect(branch.others_can).toBe('prompt');
      expect(branch.others_fs_access).toBe('write');
      expect(branch.dangerously_allow_session_sharing).toBe(true);
    }
  );

  dbTest(
    'ignores explicit branch permission fields at creation and remains board-aligned',
    async ({ db }) => {
      const users = new UsersRepository(db);
      const repos = new RepoRepository(db);
      const boards = new BoardRepository(db);
      const owner = await users.create({
        email: 'branch-explicit-owner@example.com',
        role: 'member',
      });
      const repo = await repos.create({
        name: 'branch-explicit-repo',
        slug: 'branch-explicit-repo',
        repo_type: 'local',
        local_path: '/tmp/branch-explicit-repo',
        default_branch: 'main',
      });
      const board = await boards.create({
        name: 'Prompt Defaults',
        created_by: owner.user_id,
        default_others_can: 'prompt',
        default_others_fs_access: 'write',
      });

      const app = { service: vi.fn() } as unknown as Application;
      const service = new BranchesService(db, app);
      const branch = (await service.create({
        repo_id: repo.repo_id,
        name: 'board-explicit',
        ref: 'board-explicit',
        path: '/tmp/branch-explicit-repo/board-explicit',
        board_id: board.board_id as BoardID,
        created_by: owner.user_id as UUID,
        branch_unique_id: 9302,
        new_branch: true,
        others_can: 'none',
        others_fs_access: 'none',
      })) as import('@agor/core/types').Branch;

      expect(branch.permission_source).toBe('board');
      expect(branch.others_can).toBe('prompt');
      expect(branch.others_fs_access).toBe('write');
    }
  );
});

describe('BranchesService environment health recovery', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('recovers an errored environment to running when the health URL succeeds', async () => {
    const branch = {
      branch_id: 'wt-health-recover' as BranchID,
      repo_id: 'repo-1',
      name: 'wt-health-recover',
      path: '/tmp/wt-health-recover',
      branch_unique_id: 1,
      health_check_url: 'http://localhost:3030/health',
      environment_instance: {
        status: 'error',
        last_health_check: {
          timestamp: '2026-06-27T00:00:00.000Z',
          status: 'unhealthy',
          message: 'start command exited with code 1',
        },
      },
    };
    const app = {
      service(path: string) {
        if (path === 'repos') return { get: vi.fn(async () => ({ repo_id: 'repo-1' })) };
        throw new Error(`Unknown service: ${path}`);
      },
    } as unknown as Application;
    const service = new BranchesService(createTenantScopeTestDb() as never, app);
    vi.spyOn(service, 'get').mockResolvedValue(branch as never);
    const updateEnvironment = vi.spyOn(service, 'updateEnvironment').mockImplementation(
      async (_id, update) =>
        ({
          ...branch,
          environment_instance: {
            ...branch.environment_instance,
            ...(update as Record<string, unknown>),
          },
        }) as never
    );
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK' }) as Response);

    const result = await service.checkHealth(branch.branch_id);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      branch.health_check_url,
      expect.objectContaining({ method: 'GET' })
    );
    expect(updateEnvironment).toHaveBeenCalledWith(
      branch.branch_id,
      expect.objectContaining({
        status: 'running',
        last_health_check: expect.objectContaining({ status: 'healthy', message: 'HTTP 200' }),
      }),
      undefined
    );
    expect(result.environment_instance?.status).toBe('running');
  });
});
