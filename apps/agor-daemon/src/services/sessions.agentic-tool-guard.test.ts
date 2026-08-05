/**
 * `agentic_tool` immutability was previously only a client-side convention —
 * `SessionPanel.tsx` hides "Switch tool" once a session has tasks, but
 * nothing on the server stopped a direct `sessions.patch` call (a stale tab,
 * the MCP session-update tool, CLI, a future UI surface) from changing
 * `agentic_tool` on a session with existing tasks/messages, desyncing it
 * from the tool that actually produced them.
 *
 * These tests pin the server-side guard down against a real database.
 */
import {
  BranchRepository,
  generateId,
  RepoRepository,
  SessionRepository,
  TaskRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Session, Task, UUID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { SessionsService } from './sessions';

// The guard only touches the session/task repos built from `db`; the stored
// `app` is never read on this path. A bare cast keeps the harness minimal.
const STUB_APP = {} as unknown as Application;

async function createBranch(db: any): Promise<UUID> {
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);
  const repo = await repoRepo.create({
    repo_id: generateId(),
    slug: `repo-${generateId()}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/test-repo',
    default_branch: 'main',
  });
  const branch = await branchRepo.create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'feature',
    ref: 'feature',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: '/tmp/test-repo',
    base_ref: 'main',
    new_branch: false,
    created_by: 'test-user' as UUID,
  });
  return branch.branch_id as UUID;
}

async function createSession(
  db: any,
  branchId: UUID,
  overrides: Partial<Session> = {}
): Promise<UUID> {
  const sessionRepo = new SessionRepository(db);
  const session = await sessionRepo.create({
    session_id: generateId(),
    branch_id: branchId,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    created_by: 'test-user' as UUID,
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
    ...overrides,
  });
  return session.session_id as UUID;
}

async function createTask(db: any, sessionId: UUID, overrides: Partial<Task> = {}): Promise<UUID> {
  const taskRepo = new TaskRepository(db);
  const task = await taskRepo.create({
    task_id: generateId(),
    session_id: sessionId,
    created_by: 'test-user' as UUID,
    full_prompt: 'Do a thing',
    status: TaskStatus.COMPLETED,
    message_range: { start_index: 0, end_index: 2, start_timestamp: new Date().toISOString() },
    tool_use_count: 1,
    git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
    ...overrides,
  });
  return task.task_id as UUID;
}

describe('SessionsService.patch — agentic_tool immutability guard', () => {
  dbTest(
    'keeps historical metadata readable but rejects creation and runtime reinterpretation',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const sessionId = await createSession(db, branchId, {
        agentic_tool: 'claude-code-cli',
        cli_state: { watcher_offset: 42, jsonl_path: '/historical/transcript.jsonl' },
        billing_mode: 'subscription',
      });

      const historical = await service.get(sessionId);
      expect(historical).toMatchObject({
        agentic_tool: 'claude-code-cli',
        cli_state: { watcher_offset: 42, jsonl_path: '/historical/transcript.jsonl' },
        billing_mode: 'subscription',
      });

      const patched = (await service.patch(sessionId, { title: 'Readable history' })) as Session;
      expect(patched).toMatchObject({
        title: 'Readable history',
        agentic_tool: 'claude-code-cli',
        cli_state: { watcher_offset: 42, jsonl_path: '/historical/transcript.jsonl' },
        billing_mode: 'subscription',
      });

      await expect(service.patch(sessionId, { agentic_tool: 'claude-code' })).rejects.toThrow(
        /removed experimental Claude Code CLI integration/i
      );

      await expect(
        service.create({
          branch_id: branchId,
          agentic_tool: 'claude-code-cli',
          status: SessionStatus.IDLE,
          created_by: 'test-user' as UUID,
        } as never)
      ).rejects.toThrow(/removed experimental Claude Code CLI integration/i);
    }
  );

  dbTest('rejects an agentic_tool change on a session that already has a task', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const sessionId = await createSession(db, branchId, { agentic_tool: 'claude-code' });
    await createTask(db, sessionId);

    await expect(service.patch(sessionId, { agentic_tool: 'codex' })).rejects.toThrow(
      /agentic_tool/
    );

    const sessionRepo = new SessionRepository(db);
    const reloaded = await sessionRepo.findById(sessionId);
    expect(reloaded?.agentic_tool).toBe('claude-code');
  });

  dbTest('rejects any multi (batch) patch that changes agentic_tool', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const withTask = await createSession(db, branchId, { agentic_tool: 'claude-code' });
    await createTask(db, withTask);

    await expect(
      service.patch(null, { agentic_tool: 'codex' }, { query: { session_id: withTask } } as any)
    ).rejects.toThrow(/multi-session patch/i);

    const sessionRepo = new SessionRepository(db);
    const reloaded = await sessionRepo.findById(withTask);
    expect(reloaded?.agentic_tool).toBe('claude-code');
  });

  dbTest(
    'rejects a multi patch even for a zero-task session, closing the enumeration bypass',
    async ({ db }) => {
      // The prior per-row guard enumerated the target set via `super.find`,
      // which `$select`/`$limit:0`/pagination could skew away from the rows the
      // mutation actually touched. Refusing multi-patch of agentic config
      // outright removes that mismatch: there is no separately-enumerated set to
      // exploit, so a protected row can't be slipped past the check.
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const zeroTask = await createSession(db, branchId, { agentic_tool: 'claude-code' });

      await expect(
        service.patch(null, { agentic_tool: 'codex' }, {
          query: { session_id: zeroTask, $select: ['title'], $limit: 0 },
        } as any)
      ).rejects.toThrow(/multi-session patch/i);

      const sessionRepo = new SessionRepository(db);
      expect((await sessionRepo.findById(zeroTask))?.agentic_tool).toBe('claude-code');
    }
  );

  dbTest('allows an agentic_tool change on a session with zero tasks', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const sessionId = await createSession(db, branchId, { agentic_tool: 'claude-code' });

    const result = (await service.patch(sessionId, { agentic_tool: 'codex' })) as Session;
    expect(result.agentic_tool).toBe('codex');
  });

  dbTest(
    'allows a patch that sets agentic_tool to its current value even with tasks',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const sessionId = await createSession(db, branchId, { agentic_tool: 'claude-code' });
      await createTask(db, sessionId);

      const result = (await service.patch(sessionId, { agentic_tool: 'claude-code' })) as Session;
      expect(result.agentic_tool).toBe('claude-code');
    }
  );

  dbTest('allows unrelated field patches on a session with tasks', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const sessionId = await createSession(db, branchId, { agentic_tool: 'claude-code' });
    await createTask(db, sessionId);

    const result = (await service.patch(sessionId, { title: 'New title' })) as Session;
    expect(result.title).toBe('New title');
  });
});

describe('SessionsService direct OpenCode model selection', () => {
  const modelConfig = (provider?: string, model = 'gpt-test') => ({
    mode: 'exact' as const,
    model,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...(provider === undefined ? {} : { provider }),
  });

  dbTest('rejects incomplete inline creates and accepts a complete exact pair', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const base = {
      branch_id: branchId,
      agentic_tool: 'opencode' as const,
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UUID,
    };

    await expect(service.create({ ...base, model_config: modelConfig() })).rejects.toThrow(
      /provider and model/i
    );
    await expect(
      service.create({ ...base, model_config: modelConfig('openai', '') })
    ).rejects.toThrow(/provider and model/i);

    await expect(
      service.create({ ...base, model_config: modelConfig('openai') })
    ).resolves.toMatchObject({
      agentic_tool: 'opencode',
      model_config: { provider: 'openai', model: 'gpt-test' },
    });
  });

  dbTest(
    'rejects caller-controlled indirect-create provenance before persistence',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const base = {
        branch_id: branchId,
        agentic_tool: 'opencode' as const,
        status: SessionStatus.IDLE,
        created_by: 'test-user' as UUID,
        model_config: modelConfig(),
      };
      const callerControlledProvenance: Array<Record<string, unknown>> = [
        { schedule_id: generateId() },
        { custom_context: { gateway_source: { channel_id: 'caller-controlled' } } },
        {
          genealogy: {
            forked_from_session_id: generateId(),
            fork_point_task_id: generateId(),
            children: [],
          },
        },
        {
          genealogy: {
            parent_session_id: generateId(),
            spawn_point_task_id: undefined,
            children: [],
          },
        },
        { _agenticConfigResolved: true },
      ];

      for (const provenance of callerControlledProvenance) {
        await expect(service.create({ ...base, ...provenance } as never)).rejects.toThrow(
          /provider and model/i
        );
      }

      await expect(
        service.create(base, {
          provider: 'rest',
          query: { _agenticConfigResolved: true },
        } as never)
      ).rejects.toThrow(/provider and model/i);
      expect(await new SessionRepository(db).findAll()).toEqual([]);
    }
  );

  dbTest('allows resolved internal creates plus fork and task-ID-less spawn', async ({ db }) => {
    const app = {
      service: (path: string) => {
        if (path === 'users') return { get: async () => null };
        throw new Error(`Unexpected service: ${path}`);
      },
    } as unknown as Application;
    const service = new SessionsService(db, app);
    const branchId = await createBranch(db);
    const incompleteModel = modelConfig();
    const base = {
      branch_id: branchId,
      agentic_tool: 'opencode' as const,
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UUID,
      model_config: incompleteModel,
    };

    await expect(service.create(base, { _agenticConfigResolved: true })).resolves.toMatchObject({
      model_config: incompleteModel,
    });

    const parentId = await createSession(db, branchId, {
      agentic_tool: 'opencode',
      model_config: incompleteModel,
    });
    await expect(service.fork(parentId, { prompt: 'Fork internally' })).resolves.toMatchObject({
      model_config: incompleteModel,
      genealogy: { forked_from_session_id: parentId },
    });
    const spawned = await service.spawn(parentId, { prompt: 'Spawn without a task ID' });
    expect(spawned).toMatchObject({
      model_config: { mode: 'exact', model: 'gpt-test' },
      genealogy: { parent_session_id: parentId },
    });
    expect(spawned.model_config?.provider).toBeUndefined();
    expect(spawned.genealogy?.spawn_point_task_id).toBeUndefined();
  });

  dbTest('rejects incomplete direct patches and accepts a complete exact pair', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const sessionId = await createSession(db, branchId, {
      agentic_tool: 'opencode',
      model_config: modelConfig('openai'),
    });

    await expect(service.patch(sessionId, { model_config: modelConfig() })).rejects.toThrow(
      /provider and model/i
    );
    await expect(
      service.patch(sessionId, { model_config: modelConfig('anthropic', '') })
    ).rejects.toThrow(/provider and model/i);

    await expect(
      service.patch(sessionId, { model_config: modelConfig('anthropic', 'claude-test') })
    ).resolves.toMatchObject({
      model_config: { provider: 'anthropic', model: 'claude-test' },
    });
  });
});
