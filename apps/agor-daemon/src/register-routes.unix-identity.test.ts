import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnixUserMode } from '@agor/core/config';
import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  type TaskDispatchClaimResult,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Session, Task, TaskPendingDispatchStatus, TenantID, UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { launchPendingTask } from './utils/session-unix-identity.js';

const readSource = (relativePath: string): string =>
  readFileSync(join(__dirname, relativePath), 'utf8');

const activeTenantId = 'tenant-active' as TenantID;
let branchUniqueId = 1;
let activeDb: ReturnType<typeof createTenantScopedDatabaseProxy>;
const databaseDirectories: string[] = [];

async function createTestDatabase(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `agor-${label}-`));
  databaseDirectories.push(directory);
  const rawDb = createDatabase({ url: `file:${join(directory, 'test.db')}` });
  await initializeDatabase(rawDb);
  return rawDb;
}

beforeAll(async () => {
  activeDb = createTenantScopedDatabaseProxy(await createTestDatabase('launch-active-tenant'));
});

afterAll(() => {
  for (const directory of databaseDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

type CreatorState = 'matching' | 'mismatched' | 'missing';

async function createPendingLaunch(input: {
  creatorState: CreatorState;
  status: TaskPendingDispatchStatus;
}): Promise<{ session: Session; task: Task }> {
  const creatorId = generateId() as UUID;
  const suffix = creatorId.slice(-12);
  const stampedUsername = `alice-${suffix}`;
  if (input.creatorState === 'matching' || input.creatorState === 'mismatched') {
    await runWithTenantDatabaseScope(activeDb, activeTenantId, (tenantDb) =>
      new UsersRepository(tenantDb).create({
        user_id: creatorId,
        email: `${suffix}@active.example`,
        unix_username: input.creatorState === 'matching' ? stampedUsername : `bob-${suffix}`,
      })
    );
  }

  return runWithTenantDatabaseScope(activeDb, activeTenantId, async (tenantDb) => {
    const repo = await new RepoRepository(tenantDb).create({
      repo_id: generateId(),
      slug: `unix-launch-${generateId()}`,
      name: 'Unix launch test',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/unix-launch.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(tenantDb).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `unix-launch-${suffix}`,
      ref: 'main',
      branch_unique_id: branchUniqueId++,
      path: `/tmp/${generateId()}`,
      created_by: creatorId,
    });
    const session = await new SessionRepository(tenantDb).create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      created_by: creatorId,
      agentic_tool: 'codex',
      unix_username: stampedUsername,
    });
    const task = await new TaskRepository(tenantDb).createPending({
      session_id: session.session_id,
      created_by: creatorId,
      full_prompt: 'prove the pre-claim launch boundary',
      status: input.status,
    });
    return { session, task };
  });
}

async function exerciseProductionLaunchSeam(input: {
  mode: UnixUserMode;
  branchRbac: boolean;
  creatorState: CreatorState;
  status: TaskPendingDispatchStatus;
}) {
  const { session, task } = await createPendingLaunch(input);
  const events: string[] = [];
  const originalFindById = UsersRepository.prototype.findById;
  const creatorLookup = vi
    .spyOn(UsersRepository.prototype, 'findById')
    .mockImplementation(async function (id: string) {
      events.push('lookup');
      return originalFindById.call(this, id);
    });
  const claimDispatch = vi.fn(async (pendingTask: Task & { status: TaskPendingDispatchStatus }) => {
    events.push('claim');
    return new TaskRepository(activeDb).claimDispatchAndProjectSession(
      pendingTask.task_id,
      pendingTask.status,
      { status: TaskStatus.DISPATCHING }
    );
  });
  const deferExecutorSpawn = vi.fn(() => events.push('defer'));
  const continueClaimedLaunch = vi.fn(async (claimedTask: Task) => {
    deferExecutorSpawn();
    return claimedTask;
  });
  const onClaimNotWon = vi.fn(async (claim: TaskDispatchClaimResult) => claim.task);

  let result: Task | undefined;
  let error: unknown;
  let creatorLookupCalls: string[][] = [];
  try {
    result = await launchPendingTask({
      db: activeDb,
      tenantId: activeTenantId,
      execution: {
        unix_user_mode: input.mode,
        branch_rbac: input.branchRbac,
      },
      task,
      session,
      claimDispatch,
      onClaimed: continueClaimedLaunch,
      onClaimNotWon,
    });
  } catch (cause) {
    error = cause;
  } finally {
    creatorLookupCalls = creatorLookup.mock.calls.map(([id]) => [id]);
    creatorLookup.mockRestore();
  }

  return {
    task,
    result,
    error,
    events,
    creatorLookupCalls,
    claimDispatch,
    continueClaimedLaunch,
    deferExecutorSpawn,
    onClaimNotWon,
    persisted: await runWithTenantDatabaseScope(activeDb, activeTenantId, (tenantDb) =>
      new TaskRepository(tenantDb).findById(task.task_id)
    ),
  };
}

const guardedMatrix = (['delegated', 'strict'] as const).flatMap((mode) =>
  [false, true].map((branchRbac) => ({ mode, branchRbac }))
);
const unguardedMatrix = (['simple', 'insulated'] as const).flatMap((mode) =>
  [false, true].flatMap((branchRbac) =>
    ([TaskStatus.CREATED, TaskStatus.QUEUED] as const).map((status) => ({
      mode,
      branchRbac,
      status,
    }))
  )
);
const rejectedMatrix = guardedMatrix.flatMap(({ mode, branchRbac }) =>
  (['mismatched', 'missing'] as const).flatMap((creatorState) =>
    ([TaskStatus.CREATED, TaskStatus.QUEUED] as const).map((status) => ({
      mode,
      branchRbac,
      creatorState,
      status,
    }))
  )
);

describe('production pre-claim Unix identity orchestration', () => {
  it.each(guardedMatrix)(
    '$mode with branch_rbac=$branchRbac looks up a matching creator before claim and remains launch-eligible',
    async ({ mode, branchRbac }) => {
      const observed = await exerciseProductionLaunchSeam({
        mode,
        branchRbac,
        creatorState: 'matching',
        status: TaskStatus.QUEUED,
      });

      expect(observed.error).toBeUndefined();
      expect(observed.events).toEqual(['lookup', 'claim', 'defer']);
      expect(observed.creatorLookupCalls).toEqual([[observed.task.created_by]]);
      expect(observed.claimDispatch).toHaveBeenCalledOnce();
      expect(observed.continueClaimedLaunch).toHaveBeenCalledOnce();
      expect(observed.deferExecutorSpawn).toHaveBeenCalledOnce();
      expect(observed.onClaimNotWon).not.toHaveBeenCalled();
      expect(observed.result?.status).toBe(TaskStatus.DISPATCHING);
      expect(observed.persisted?.status).toBe(TaskStatus.DISPATCHING);
    }
  );

  it.each(rejectedMatrix)(
    '$mode with branch_rbac=$branchRbac rejects $creatorState creator before claim/spawn and leaves $status pending',
    async ({ mode, branchRbac, creatorState, status }) => {
      const observed = await exerciseProductionLaunchSeam({
        mode,
        branchRbac,
        creatorState,
        status,
      });

      expect(observed.error).toBeInstanceOf(Error);
      expect((observed.error as Error).message).toMatch(
        creatorState === 'mismatched'
          ? /Session security context has changed/
          : /Session creator not found/
      );
      expect(observed.events).toEqual(['lookup']);
      expect(observed.creatorLookupCalls).toEqual([[observed.task.created_by]]);
      expect(observed.claimDispatch).not.toHaveBeenCalled();
      expect(observed.continueClaimedLaunch).not.toHaveBeenCalled();
      expect(observed.deferExecutorSpawn).not.toHaveBeenCalled();
      expect(observed.onClaimNotWon).not.toHaveBeenCalled();
      expect(observed.persisted?.status).toBe(status);
    }
  );

  it.each(unguardedMatrix)(
    '$mode with branch_rbac=$branchRbac does not look up a missing creator and preserves $status claim behavior',
    async ({ mode, branchRbac, status }) => {
      const observed = await exerciseProductionLaunchSeam({
        mode,
        branchRbac,
        creatorState: 'missing',
        status,
      });

      expect(observed.error).toBeUndefined();
      expect(observed.events).toEqual(['claim', 'defer']);
      expect(observed.creatorLookupCalls).toEqual([]);
      expect(observed.claimDispatch).toHaveBeenCalledOnce();
      expect(observed.continueClaimedLaunch).toHaveBeenCalledOnce();
      expect(observed.deferExecutorSpawn).toHaveBeenCalledOnce();
      expect(observed.onClaimNotWon).not.toHaveBeenCalled();
      expect(observed.result?.status).toBe(TaskStatus.DISPATCHING);
      expect(observed.persisted?.status).toBe(TaskStatus.DISPATCHING);
    }
  );
});

describe('production launch convergence', () => {
  const routesSource = readSource('register-routes.ts');
  const spawnStart = routesSource.indexOf('async function spawnTaskExecutor(');
  const promptStart = routesSource.indexOf("'/sessions/:id/prompt'", spawnStart);
  const spawnTaskExecutor = routesSource.slice(spawnStart, promptStart);

  it('wires the production claim and deferred spawn through the tested orchestration seam', () => {
    const launchOrchestration = spawnTaskExecutor.indexOf('return launchPendingTask({');
    const dispatchClaim = spawnTaskExecutor.indexOf(
      'tasksService.claimDispatchAndProjectSession(',
      launchOrchestration
    );
    const claimedContinuation = spawnTaskExecutor.indexOf(
      'onClaimed: async (updatedTask)',
      dispatchClaim
    );
    const executorSpawn = spawnTaskExecutor.indexOf(
      'deferInFreshTenantScope(params, async () =>',
      claimedContinuation
    );

    expect(spawnStart).toBeGreaterThan(0);
    expect(launchOrchestration).toBeGreaterThan(0);
    expect(dispatchClaim).toBeGreaterThan(launchOrchestration);
    expect(claimedContinuation).toBeGreaterThan(dispatchClaim);
    expect(executorSpawn).toBeGreaterThan(claimedContinuation);
    expect(spawnTaskExecutor).not.toContain('branchRbacEnabled');
  });

  it('converges direct prompts, explicit runs, and queue drains on the guarded launch seam', () => {
    const runStart = routesSource.indexOf("'/tasks/:id/run'", promptStart);
    const spawnPromptStart = routesSource.indexOf("'/sessions/:id/spawn-prompt'", runStart);
    const queueStart = routesSource.indexOf('async function processNextQueuedTaskInternal(');
    const queueEnd = routesSource.indexOf('// Inject queue processor', queueStart);

    const promptRoute = routesSource.slice(promptStart, runStart);
    const runRoute = routesSource.slice(runStart, spawnPromptStart);
    const queueDrain = routesSource.slice(queueStart, queueEnd);

    expect(promptRoute).toContain('const admitted = await spawnTaskExecutor(');
    expect(runRoute).toContain('spawnFn: spawnTaskExecutor');
    expect(queueDrain).toContain('const admitted = await spawnTaskExecutor(');
  });

  it('routes reactive/fleet drains and representative callback/scheduled work to that queue seam', () => {
    const hooksSource = readSource('register-hooks.ts');
    const startupSource = readSource('startup.ts');
    const tasksSource = readSource('services/tasks.ts');
    const schedulerSource = readSource('services/scheduler.ts');

    expect(hooksSource).toContain(
      'await sessionsService.triggerQueueProcessing(session.session_id, queueParams);'
    );
    expect(startupSource).toContain('const sessionQueueWorker = new SessionQueueWorker(db, {');
    expect(startupSource).toContain(
      'ctx.sessionsService.triggerQueueProcessing(sessionId, params as never)'
    );
    expect(tasksSource).toContain('const createCallbackTask = () =>');
    expect(tasksSource).toContain('status: TaskStatus.QUEUED');
    expect(tasksSource).toContain(
      'await this.triggerQueueProcessingAfterCommit(targetSessionId, {});'
    );
    expect(schedulerSource).toContain("this.app.service('/sessions/:id/prompt').create(");
    expect(schedulerSource).toContain('idempotencyTaskId: initialTaskId');
  });
});
