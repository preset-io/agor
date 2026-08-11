import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgorConfig } from '@agor/core/config';
import { resolveSecurity } from '@agor/core/config';
import {
  BranchRepository,
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
} from '@agor/core/db';
import { feathers, feathersExpress, rest, socketio } from '@agor/core/feathers';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { registerRoutes } from './register-routes.js';
import { registerServices } from './register-services.js';

class ControlledAdmissionLatch implements PromiseLike<void> {
  readonly reached: Promise<void>;
  private readonly blocked: Promise<void>;
  private readonly releaseBlocked: () => void;
  private readonly signalReached: () => void;

  constructor() {
    let releaseBlocked!: () => void;
    let signalReached!: () => void;
    this.blocked = new Promise<void>((resolve) => (releaseBlocked = resolve));
    this.reached = new Promise<void>((resolve) => (signalReached = resolve));
    this.releaseBlocked = releaseBlocked;
    this.signalReached = signalReached;
  }

  // biome-ignore lint/suspicious/noThenProperty: intentional await-assimilation signal for this test gate
  then<TResult1 = void, TResult2 = never>(
    // biome-ignore lint/suspicious/noConfusingVoidType: exact Promise<void> implementation signature
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    this.signalReached();
    return this.blocked.then(onfulfilled, onrejected);
  }

  release(): void {
    this.releaseBlocked();
  }
}

describe('prompt and widget transaction scopes', () => {
  const source = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');

  it('uses the long-route identity scope and short Task repository units for prompt admission', () => {
    const promptStart = source.indexOf("'/sessions/:id/prompt'");
    const promptEnd = source.indexOf("'/tasks/:id/run'", promptStart);
    const prompt = source.slice(promptStart - 100, promptEnd);

    expect(promptStart).toBeGreaterThan(0);
    expect(prompt).toContain('registerLongAuthenticatedRoute(');
    expect(prompt).toContain('bindRepositoryToTenantUnitOfWork(db, new TaskRepository(db))');
    expect(prompt).toContain(
      'isAgenticToolEnabledForTenant(db, promptTenantId, activeAgenticTool)'
    );
    expect(prompt).not.toContain(
      "registerAuthenticatedRoute(\n    app,\n    '/sessions/:id/prompt'"
    );
  });

  it('does not keep a route-wide tenant transaction over widget external work', () => {
    for (const path of ["'/widgets/:id/submit'", "'/widgets/:id/dismiss'"]) {
      const start = source.indexOf(path);
      const route = source.slice(start - 100, start + 900);
      expect(start).toBeGreaterThan(0);
      expect(route).toContain('registerLongAuthenticatedRoute(');
    }
  });

  it('routes prompt admission and explicit Task runs through server-owned provenance', () => {
    const promptStart = source.indexOf("'/sessions/:id/prompt'");
    const runStart = source.indexOf("'/tasks/:id/run'", promptStart);
    const prompt = source.slice(promptStart, runStart);
    const run = source.slice(runStart, source.indexOf("'/sessions/:id/spawn-prompt'", runStart));

    expect(prompt).toContain('normalizeMessageSource(data.messageSource, params)');
    expect(prompt).toContain('buildPromptTaskMetadata(data.metadata, messageSource, createdBy');
    expect(run).toContain('messageSource: normalizeMessageSource(data.messageSource, params)');
  });

  it('does not claim or launch direct admission until standalone recovery releases it', async () => {
    const tenantId = 'prompt-admission-test';
    const jwtSecret = 'prompt-admission-test-secret';
    const config = {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: tenantId },
      execution: {
        branch_rbac: false,
        allow_superadmin: false,
        unix_user_mode: 'simple',
        allow_web_terminal: false,
        daemon_writes_user_message: false,
        bootstrap_superadmin_users: [],
      },
    } satisfies AgorConfig;
    const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    const db = createTenantScopedDatabaseProxy(rawDb);
    const app = feathersExpress(feathers());
    const taskAdmissionReady = new ControlledAdmissionLatch();
    let admissionOutcome:
      | Promise<{ status: 'fulfilled'; value: unknown } | { status: 'rejected'; reason: unknown }>
      | undefined;
    let executorLaunchStarted: Promise<void> | undefined;

    try {
      await initializeDatabase(rawDb);
      app.configure(rest());
      app.configure(socketio());
      app.set('database', db);
      app.set('config', config);
      app.set('distributedWorkIdentity', { instanceId: 'test-daemon', bootId: 'test-boot' });
      const services = await registerServices({
        db,
        app,
        config,
        jwtSecret,
        daemonUrl: 'http://localhost:3030',
        bundledUiAvailable: false,
        DAEMON_PORT: 3030,
        UI_PORT: 5173,
        branchRbacEnabled: false,
        allowSuperadmin: false,
        requireAuth: async (context) => context,
        deployment: { mode: 'standalone' },
      });
      await registerRoutes({
        db,
        app,
        config,
        jwtSecret,
        branchRbacEnabled: false,
        requireAuth: async (context) => context,
        enforcePasswordChange: async (context) => context,
        superadminOpts: { allowSuperadmin: false },
        DB_PATH: ':memory:',
        DAEMON_PORT: 3030,
        DAEMON_VERSION: 'test',
        AGOR_VERSION: 'test',
        DAEMON_BUILD_INFO: { sha: 'dev', builtAt: null, source: 'fallback' },
        resolvedSecurity: resolveSecurity(config, { daemonUrl: 'http://localhost:3030' }),
        distributedWorkIdentity: { instanceId: 'test-daemon', bootId: 'test-boot' },
        deployment: { mode: 'standalone' },
        sessionsService: services.sessionsService,
        messagesService: services.messagesService,
        boardsService: services.boardsService,
        branchRepository: services.branchRepository,
        usersRepository: services.usersRepository,
        sessionsRepository: services.sessionsRepository,
        sessionMCPServersService: services.sessionMCPServersService,
        sessionEnvSelectionsService: services.sessionEnvSelectionsService,
        terminalsService: services.terminalsService,
        taskAdmissionReady: taskAdmissionReady as unknown as Promise<void>,
      });

      const seeded = await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
        const userId = generateId();
        const repo = await new RepoRepository(tenantDb).create({
          repo_id: generateId(),
          slug: `prompt-admission-${generateId()}`,
          name: 'Prompt admission',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/prompt-admission.git',
          local_path: '/tmp/prompt-admission',
          default_branch: 'main',
        });
        const branch = await new BranchRepository(tenantDb).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          name: 'prompt-admission',
          ref: 'main',
          branch_unique_id: Date.now() % 2_000_000_000,
          path: '/tmp/prompt-admission/branch',
          created_by: userId,
        });
        const session = await new SessionRepository(tenantDb).create({
          session_id: generateId(),
          branch_id: branch.branch_id,
          agentic_tool: 'codex',
          created_by: userId,
          status: SessionStatus.IDLE,
          ready_for_prompt: true,
        });
        const task = await new TaskRepository(tenantDb).create({
          task_id: generateId(),
          session_id: session.session_id,
          created_by: userId,
          full_prompt: 'wait for recovery',
          status: TaskStatus.CREATED,
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: 'prompt-admission-test' },
          tool_use_count: 0,
        });
        return { session, task, userId };
      });
      const tasksService = app.service('tasks') as unknown as {
        claimDispatchAndProjectSession: (...args: never[]) => Promise<unknown>;
      };
      const claim = vi.spyOn(tasksService, 'claimDispatchAndProjectSession');
      let signalExecutorLaunch!: () => void;
      executorLaunchStarted = new Promise<void>((resolve) => (signalExecutorLaunch = resolve));
      const launch = vi
        .spyOn(services.sessionsService, 'executeTask')
        .mockImplementation(async () => {
          signalExecutorLaunch();
          return undefined as never;
        });

      const admission = app.service('/tasks/:id/run').create({}, {
        route: { id: seeded.task.task_id },
        tenant: { tenant_id: tenantId, source: 'explicit' },
        user: { user_id: seeded.userId, role: 'member' },
      } as never);
      admissionOutcome = admission.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason })
      );
      const gateState = await Promise.race([
        taskAdmissionReady.reached.then(() => ({ status: 'reached' as const })),
        admissionOutcome.then((outcome) => ({ status: 'settled' as const, outcome })),
      ]);
      if (gateState.status === 'settled') {
        if (gateState.outcome.status === 'rejected') throw gateState.outcome.reason;
        throw new Error('Task run route settled without awaiting the admission gate');
      }

      expect(claim).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();

      taskAdmissionReady.release();
      const outcome = await admissionOutcome;
      if (outcome.status === 'rejected') throw outcome.reason;
      expect(outcome.value).toMatchObject({ status: TaskStatus.DISPATCHING });
      expect(claim).toHaveBeenCalledOnce();
      await executorLaunchStarted;
      await Promise.resolve();
      expect(launch).toHaveBeenCalledOnce();
    } finally {
      taskAdmissionReady.release();
      const outcome = admissionOutcome ? await admissionOutcome : undefined;
      if (outcome?.status === 'fulfilled' && executorLaunchStarted) {
        await executorLaunchStarted;
        await Promise.resolve();
      }
      try {
        await app.teardown();
      } finally {
        (rawDb as unknown as { $client: { close(): void } }).$client.close();
      }
    }
  });

  it('restores the queued user before hooked Session recovery under branch RBAC', () => {
    const start = source.indexOf('async function processNextQueuedTaskInternal(');
    const end = source.indexOf('// Inject queue processor into sessions service.', start);
    const drain = source.slice(start, end);

    expect(start).toBeGreaterThan(0);
    const userLookup = drain.indexOf('userRepo.findById(userId)');
    const sessionRead = drain.indexOf('sessionsService.get(sessionId, taskParams)');
    expect(userLookup).toBeGreaterThan(0);
    expect(sessionRead).toBeGreaterThan(userLookup);
    expect(drain).toMatch(
      /reconcileSessionPromptStateIfStuck\(\s*queuedSession,\s*taskRepo,\s*taskParams\s*\)/
    );
    expect(drain).not.toContain('event=drain_started');
    expect(drain).toContain('event=dispatched');
  });
});
