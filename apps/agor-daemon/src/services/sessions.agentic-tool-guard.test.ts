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
import type { CreateSessionInput, HookContext, Session, Task, UUID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { applySessionConfigDefaults } from '../utils/apply-session-config-defaults';
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
    git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
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

describe('SessionsService OpenCode model_config validation', () => {
  function createInput(branchId: UUID, modelConfig: CreateSessionInput['model_config']) {
    return {
      session_id: generateId(),
      branch_id: branchId,
      agentic_tool: 'opencode' as const,
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UUID,
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
      tasks: [],
      contextFiles: [],
      genealogy: { children: [] },
      model_config: modelConfig,
    } satisfies CreateSessionInput;
  }

  dbTest(
    'preserves a deliberate clear through the create hook and persists absence without restoring a stale default',
    async ({ db }) => {
      const branchId = await createBranch(db);
      const data = createInput(branchId, null);
      const context = {
        params: { provider: 'rest', user: { user_id: data.created_by } },
        data,
        app: {
          service: () => ({
            get: async () => ({
              user_id: data.created_by,
              default_agentic_config: {
                opencode: {
                  modelConfig: {
                    mode: 'exact',
                    provider: 'openai',
                    model: 'stale-user-model',
                  },
                },
              },
            }),
          }),
        },
      } as unknown as HookContext;

      await applySessionConfigDefaults({ warnOnExternalDefaultFill: false })(context);
      expect(context.data).toHaveProperty('model_config', null);

      const service = new SessionsService(db, STUB_APP);
      const created = (await service.create(context.data as CreateSessionInput)) as Session;
      expect(created.model_config).toBeNull();
      expect(
        (await new SessionRepository(db).findById(created.session_id))?.model_config
      ).toBeNull();
    }
  );

  dbTest('rejects incomplete and blank OpenCode pairs on create', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const invalidConfigs = [
      { mode: 'exact', model: 'gpt-5', updated_at: 'now' },
      { mode: 'exact', provider: 'openai', updated_at: 'now' },
      { mode: 'exact', provider: 'openai', model: '   ', updated_at: 'now' },
      { mode: 'exact', provider: '   ', model: 'gpt-5', updated_at: 'now' },
    ] as CreateSessionInput['model_config'][];

    for (const modelConfig of invalidConfigs) {
      await expect(service.create(createInput(branchId, modelConfig))).rejects.toThrow(
        /provider.*model/i
      );
    }
  });

  dbTest('rejects incomplete and blank OpenCode pairs on patch', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const sessionId = await createSession(db, branchId, {
      agentic_tool: 'opencode',
      model_config: null,
    });
    const invalidConfigs = [
      { mode: 'exact', model: 'gpt-5', updated_at: 'now' },
      { mode: 'exact', provider: 'openai', updated_at: 'now' },
      { mode: 'exact', provider: 'openai', model: '   ', updated_at: 'now' },
      { mode: 'exact', provider: '   ', model: 'gpt-5', updated_at: 'now' },
    ] as NonNullable<Session['model_config']>[];

    for (const model_config of invalidConfigs) {
      await expect(service.patch(sessionId, { model_config })).rejects.toThrow(/provider.*model/i);
    }
  });

  dbTest('preserves a valid exact pair and existing-session null clears', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const exact = {
      mode: 'exact' as const,
      provider: 'openai',
      model: 'gpt-5',
      updated_at: 'now',
    };

    const created = (await service.create(createInput(branchId, exact))) as Session;
    expect(created.model_config).toEqual(exact);

    const cleared = (await service.patch(created.session_id, { model_config: null })) as Session;
    expect(cleared.model_config).toBeNull();

    const restored = (await service.patch(created.session_id, { model_config: exact })) as Session;
    expect(restored.model_config).toEqual(exact);
  });
});
