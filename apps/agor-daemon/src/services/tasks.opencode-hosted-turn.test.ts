import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sealOpenCodeCheckpoint } from '@agor/agentic-tool-opencode/runtime';
import {
  BranchRepository,
  type Database,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import {
  type SessionID,
  type SessionSdkHomeScope,
  SessionStatus,
  type TaskID,
  TaskStatus,
} from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import {
  completeManagedOpenCodeTurn,
  prepareManagedOpenCodeTurn,
} from '../../../../packages/executor/src/handlers/sdk/opencode-managed';
import { TasksService } from './tasks.js';

// Executor and daemon meet here with no stubs between them; every call is JSON round-tripped like the wire.
const hosted = {
  multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
  execution: {
    unix_user_mode: 'delegated',
    executor_command_template: 'launch {task_id}',
    executor_storage: { user_home: 'persistent-per-user' },
    sandbox: { sdk_home_mode: 'per_branch' },
  },
};

let scratch: string;
let home: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agor-oc-scratch-'));
  home = await mkdtemp(join(tmpdir(), 'agor-oc-home-'));
  vi.stubEnv('AGOR_OPENCODE_SCRATCH_ROOT', scratch);
  vi.stubEnv('HOME', home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(scratch, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const wire = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

describe('hosted OpenCode turn across executor and daemon', () => {
  async function hostedSession(db: Database, sdkHomeScope: SessionSdkHomeScope) {
    const users = new UsersRepository(db);
    const owner = await users.create({ email: `${generateId()}@example.com`, name: 'Owner' });
    await users.setToolConfigField(owner.user_id, 'opencode', 'zai', 'sk-owner');
    const repo = await new RepoRepository(db).create({
      slug: `oc-${generateId()}`,
      name: 'repo',
      repo_type: 'remote',
      remote_url: 'https://example.com/r.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      repo_id: repo.repo_id,
      name: `b-${generateId()}`,
      ref: 'main',
      branch_unique_id: Math.floor(Math.random() * 1_000_000),
      path: `/tmp/${generateId()}`,
      base_ref: 'main',
      new_branch: false,
      created_by: owner.user_id,
    });
    const session = await new SessionRepository(db).create({
      branch_id: branch.branch_id,
      created_by: owner.user_id,
      agentic_tool: 'opencode',
      status: SessionStatus.IDLE,
      sdk_home_scope: sdkHomeScope,
      model_config: {
        mode: 'exact',
        provider: 'zai',
        model: 'glm-4.6',
        updated_at: new Date().toISOString(),
      },
    });
    const taskRepo = new TaskRepository(db);
    Reflect.set(taskRepo, 'assertRuntimeCredentialAuthority', async () => undefined);

    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'db', db);
    Reflect.set(service, 'taskRepo', taskRepo);
    Reflect.set(service, 'app', { get: () => hosted, service: () => ({ emit: () => undefined }) });
    Reflect.set(service, 'get', async (id: string) => taskRepo.findById(id));
    Reflect.set(service, 'runtimeAuthorityScope', async () => ({}));
    Reflect.set(service, 'processCompletionSideEffects', async () => undefined);
    // The first retirement fails after completion commits, as a transient revocation error would.
    const retired: string[] = [];
    Reflect.set(service, 'retireTaskExecutorCredentials', async (task: { task_id: string }) => {
      retired.push(task.task_id);
      if (retired.length === 1) throw new Error('revocation store unavailable');
    });
    Reflect.set(service, 'trackTaskCompleted', () => undefined);
    Reflect.set(service, 'trackTaskStarted', () => undefined);

    async function runTurn(prompt: string, actorId = owner.user_id) {
      const task = await taskRepo.create({
        session_id: session.session_id,
        created_by: actorId,
        status: TaskStatus.DISPATCHING,
        full_prompt: prompt,
      });
      // Production connects the executor (DISPATCHING -> RUNNING) before the handler runs.
      await taskRepo.connectExecutor(task.task_id);
      const params = {
        provider: 'rest',
        tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
        authentication: {
          strategy: 'jwt',
          accessToken: 'token',
          payload: {
            type: 'executor-session',
            purpose: 'executor-task',
            sub: actorId,
            tenant_id: 'tenant-a',
            session_id: session.session_id,
            task_id: task.task_id,
            branch_id: branch.branch_id,
          },
        },
      } as never;
      const tasks = {
        beginOpenCodeCheckpoint: async (data: unknown) =>
          wire(await service.beginOpenCodeCheckpoint(wire(data) as never, params)),
        acknowledgeOpenCodeCleanup: async (data: unknown) =>
          wire(await service.acknowledgeOpenCodeCleanup(wire(data) as never, params)),
        get: async (id: string) => wire(await taskRepo.findById(id)),
        patch: async (id: string, data: unknown) =>
          wire(await service.patch(id, wire(data) as never, params)),
      };
      const client = { service: () => tasks } as never;
      const turn = await prepareManagedOpenCodeTurn({
        client,
        sessionId: session.session_id as SessionID,
        taskId: task.task_id as TaskID,
        sdkHomeScope,
        provider: 'zai',
      });
      if (!turn) throw new Error('duplicate admission');

      // Stand-in for the OpenCode server: append this turn to the live database on scratch.
      const live = new DatabaseSync(turn.layout.liveDbPath);
      live.exec('CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY)');
      live.exec('CREATE TABLE IF NOT EXISTS turn (prompt TEXT)');
      live.prepare('INSERT OR IGNORE INTO session (id) VALUES (?)').run('ses_hosted');
      live.prepare('INSERT INTO turn (prompt) VALUES (?)').run(prompt);
      const turns = (live.prepare('SELECT prompt FROM turn').all() as { prompt: string }[]).map(
        (row) => row.prompt
      );
      live.close();

      const manifest = await sealOpenCodeCheckpoint(turn.layout, 'ses_hosted');
      await completeManagedOpenCodeTurn(
        client,
        task.task_id as TaskID,
        { status: TaskStatus.COMPLETED },
        turn,
        manifest
      );
      expect((await taskRepo.findById(task.task_id))?.status).toBe(TaskStatus.COMPLETED);
      return { turn, turns, key: JSON.parse(turn.authContent).zai.key as string };
    }

    return { owner, users, retired, runTurn };
  }

  dbTest('admits, seals, accepts, and restores across two turns', async ({ db }) => {
    const { retired, runTurn } = await hostedSession(db, 'execution_home');

    const first = await runTurn('hi');
    expect(first.turn.input).toBeNull();
    expect(first.turns).toEqual(['hi']);
    expect(first.key).toBe('sk-owner');
    // The completion retry re-patched the completed Task, so retirement ran again.
    expect(retired).toHaveLength(2);
    expect(new Set(retired).size).toBe(1);

    const second = await runTurn('again');
    expect(second.turn.input?.openCodeSessionId).toBe('ses_hosted');
    expect(second.turns).toEqual(['hi', 'again']);
  });

  dbTest('continues a branch-home Session across prompters with each key', async ({ db }) => {
    const branchHome = await mkdtemp(join(tmpdir(), 'agor-oc-branch-'));
    vi.stubEnv('AGOR_OPENCODE_CHECKPOINT_ROOT', join(branchHome, 'opencode'));
    try {
      const { users, runTurn } = await hostedSession(db, 'branch');
      const teammate = await users.create({ email: `${generateId()}@example.com`, name: 'Mate' });
      await users.setToolConfigField(teammate.user_id, 'opencode', 'zai', 'sk-teammate');

      const first = await runTurn('hi');
      const second = await runTurn('again', teammate.user_id);
      const third = await runTurn('back');

      expect([first.key, second.key, third.key]).toEqual(['sk-owner', 'sk-teammate', 'sk-owner']);
      expect(second.turns).toEqual(['hi', 'again']);
      expect(third.turns).toEqual(['hi', 'again', 'back']);
      // Checkpoints live only in the branch home, never in a prompter's home.
      expect(second.turn.layout.sessionsDir).toBe(join(branchHome, 'opencode', 'sessions'));
      expect(await readdir(home)).toEqual([]);
    } finally {
      await rm(branchHome, { recursive: true, force: true });
    }
  });
});
