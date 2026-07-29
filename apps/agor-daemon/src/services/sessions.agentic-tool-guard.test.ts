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
  AgenticToolPresetRepository,
  BranchRepository,
  generateId,
  RepoRepository,
  runWithTenantContext,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { CreateSessionInput, Session, Task, UUID } from '@agor/core/types';
import { SessionStatus, TaskStatus, USER_DEFAULT_AGENTIC_CONFIGURATION } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { type SessionParams, SessionsService } from './sessions';

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
    'resolves a missing create pair from the personal default before persistence',
    async ({ db }) => {
      const branchId = await createBranch(db);
      const owner = await new UsersRepository(db).create({
        email: `opencode-owner-${generateId()}@example.com`,
        name: 'OpenCode owner',
        default_agentic_config: {
          opencode: {
            modelConfig: {
              mode: 'exact',
              provider: 'openai',
              model: 'stale-user-model',
            },
            permissionMode: 'yolo',
          },
        },
      });
      const data = { ...createInput(branchId, undefined), created_by: owner.user_id };

      const service = new SessionsService(db, STUB_APP);
      const created = (await service.create(data)) as Session;
      expect(created.model_config).toMatchObject({
        mode: 'exact',
        provider: 'openai',
        model: 'stale-user-model',
      });
      expect(created.permission_config).toEqual({ mode: 'yolo' });
      const persisted = await new SessionRepository(db).findById(created.session_id);
      expect(persisted?.model_config).toEqual(created.model_config);
      expect(persisted?.permission_config).toEqual({ mode: 'yolo' });
    }
  );

  dbTest(
    'persists an explicit OpenCode permission override ahead of the personal default',
    async ({ db }) => {
      const branchId = await createBranch(db);
      const owner = await new UsersRepository(db).create({
        email: `opencode-permission-owner-${generateId()}@example.com`,
        name: 'OpenCode owner',
        default_agentic_config: {
          opencode: {
            modelConfig: {
              mode: 'exact',
              provider: 'openai',
              model: 'stale-user-model',
            },
            permissionMode: 'yolo',
          },
        },
      });
      const data = {
        ...createInput(branchId, undefined),
        created_by: owner.user_id,
        permission_config: { mode: 'autoEdit' as const },
      };
      const created = (await new SessionsService(db, STUB_APP).create(data)) as Session;
      const persisted = await new SessionRepository(db).findById(created.session_id);

      expect(created.permission_config).toEqual({ mode: 'autoEdit' });
      expect(persisted?.permission_config).toEqual({ mode: 'autoEdit' });
    }
  );

  dbTest('proves saved personal pair → reload → new-session inheritance', async ({ db }) => {
    const user = await new UsersRepository(db).create({
      email: `opencode-default-${generateId()}@example.com`,
      name: 'OpenCode owner',
      default_agentic_config: {
        opencode: {
          modelConfig: {
            mode: 'exact',
            provider: 'saved-provider',
            model: 'saved-model',
          },
        },
      },
    });
    const reloadedUser = await new UsersRepository(db).findById(user.user_id);
    expect(reloadedUser?.default_agentic_config?.opencode?.modelConfig).toMatchObject({
      provider: 'saved-provider',
      model: 'saved-model',
    });

    const branchId = await createBranch(db);
    const data = {
      ...createInput(branchId, undefined),
      created_by: user.user_id,
    };
    const created = (await new SessionsService(db, STUB_APP).create(data)) as Session;
    const persisted = await new SessionRepository(db).findById(created.session_id);

    expect(created.model_config).toMatchObject({
      mode: 'exact',
      provider: 'saved-provider',
      model: 'saved-model',
    });
    expect(persisted?.model_config).toEqual(created.model_config);
  });

  dbTest('rejects a missing OpenCode pair before create persistence', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const data = createInput(branchId, null);

    await expect(service.create(data)).rejects.toThrow(/select.*provider.*model/i);
    expect(await new SessionRepository(db).findById(data.session_id)).toBeNull();
  });

  dbTest(
    'keeps a legacy incomplete session readable but rejects runtime materialization',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const sessionId = await createSession(db, branchId, {
        agentic_tool: 'opencode',
        model_config: null,
      });
      const readable = await service.get(sessionId);

      expect(readable.model_config).toBeNull();
      await expect(
        runWithTenantContext('tenant-opencode', () =>
          service.materializeAgenticToolConfiguration(readable)
        )
      ).rejects.toThrow(/select.*provider.*model/i);
      expect((await service.get(sessionId)).model_config).toBeNull();
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

  dbTest(
    'preserves a valid exact pair and rejects an existing-session null clear',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const exact = {
        mode: 'exact' as const,
        provider: 'openai',
        model: 'gpt-5',
        updated_at: 'now',
      };

      const created = (await service.create(createInput(branchId, exact))) as Session;
      expect(created.model_config).toMatchObject({
        mode: exact.mode,
        provider: exact.provider,
        model: exact.model,
        updated_at: expect.any(String),
      });

      await expect(service.patch(created.session_id, { model_config: null })).rejects.toThrow(
        /select.*provider.*model/i
      );
      expect((await service.get(created.session_id)).model_config).toMatchObject({
        mode: exact.mode,
        provider: exact.provider,
        model: exact.model,
        updated_at: expect.any(String),
      });
    }
  );
});

describe('SessionsService referenced configuration ownership', () => {
  const SPAWN_APP = {
    service: () => ({ get: async () => null }),
  } as unknown as Application;

  dbTest(
    'lets an explicit OpenCode preset replace the parent model pair during spawn',
    async ({ db }) => {
      const branchId = await createBranch(db);
      const parentId = await createSession(db, branchId, {
        agentic_tool: 'opencode',
        model_config: {
          mode: 'exact',
          provider: 'parent-provider',
          model: 'parent-model',
          updated_at: 'now',
        },
      });
      const preset = await new AgenticToolPresetRepository(db).create(
        {
          tool: 'opencode',
          name: 'Spawn target',
          configuration: {
            modelConfig: {
              mode: 'exact',
              provider: 'preset-provider',
              model: 'preset-model',
            },
          },
        },
        'test-user' as UUID
      );

      const spawned = await new SessionsService(db, SPAWN_APP).spawn(parentId, {
        prompt: 'Use the selected preset',
        agent: 'opencode',
        presetId: preset.preset_id,
      });

      expect(spawned.agentic_tool_preset_id).toBe(preset.preset_id);
      expect(spawned.model_config).toMatchObject({
        provider: 'preset-provider',
        model: 'preset-model',
      });
    }
  );

  dbTest(
    'reads a selected OpenCode preset before validating a cross-tool spawn',
    async ({ db }) => {
      const branchId = await createBranch(db);
      const parentId = await createSession(db, branchId, {
        agentic_tool: 'claude-code',
        model_config: { mode: 'exact', model: 'claude-sonnet-5', updated_at: 'now' },
      });
      const preset = await new AgenticToolPresetRepository(db).create(
        {
          tool: 'opencode',
          name: 'Cross-tool target',
          configuration: {
            modelConfig: {
              mode: 'exact',
              provider: 'preset-provider',
              model: 'preset-model',
            },
          },
        },
        'test-user' as UUID
      );

      await expect(
        new SessionsService(db, SPAWN_APP).spawn(parentId, {
          prompt: 'Switch tools',
          agent: 'opencode',
          presetId: preset.preset_id,
        })
      ).resolves.toMatchObject({
        agentic_tool: 'opencode',
        agentic_tool_preset_id: preset.preset_id,
        model_config: {
          provider: 'preset-provider',
          model: 'preset-model',
        },
      });
    }
  );

  dbTest(
    'resolves a referenced Codex child as source then same-tool parent then owner',
    async ({ db }) => {
      const user = await new UsersRepository(db).create({
        email: `referenced-child-${generateId()}@example.com`,
        name: 'Referenced child owner',
        default_agentic_config: {
          codex: {
            permissionMode: 'ask',
            codexSandboxMode: 'read-only',
            codexApprovalPolicy: 'untrusted',
            codexNetworkAccess: true,
            modelConfig: { mode: 'exact', model: 'personal-codex-model' },
          },
        },
      });
      const branchId = await createBranch(db);
      const parentId = await createSession(db, branchId, {
        agentic_tool: 'codex',
        created_by: user.user_id,
        permission_config: {
          mode: 'allow-all',
          codex: {
            sandboxMode: 'danger-full-access',
            approvalPolicy: 'never',
            networkAccess: false,
          },
        },
        model_config: { mode: 'exact', model: 'parent-codex-model', updated_at: 'now' },
      });
      const preset = await new AgenticToolPresetRepository(db).create(
        {
          tool: 'codex',
          name: 'Layered child preset',
          configuration: {
            permissionMode: 'auto',
            codexApprovalPolicy: 'on-request',
          },
        },
        user.user_id
      );

      const service = new SessionsService(db, SPAWN_APP);
      const spawned = await service.spawn(parentId, {
        prompt: 'Use every child layer',
        agent: 'codex',
        presetId: preset.preset_id,
      });

      expect(spawned.permission_config).toEqual({
        mode: 'auto',
        codex: {
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'on-request',
          networkAccess: false,
        },
      });
      expect(spawned.model_config?.model).toBe('parent-codex-model');
      const materialized = await runWithTenantContext('tenant-child', () =>
        service.materializeAgenticToolConfiguration(spawned)
      );
      expect(materialized.permission_config).toEqual(spawned.permission_config);
      expect(materialized.model_config?.model).toBe('parent-codex-model');
    }
  );

  dbTest(
    'does not leak a cross-tool parent through a referenced child fallback',
    async ({ db }) => {
      const user = await new UsersRepository(db).create({
        email: `cross-tool-child-${generateId()}@example.com`,
        name: 'Cross-tool child owner',
        default_agentic_config: {
          codex: {
            permissionMode: 'ask',
            codexSandboxMode: 'read-only',
            codexApprovalPolicy: 'untrusted',
            codexNetworkAccess: false,
            modelConfig: { mode: 'exact', model: 'personal-codex-model' },
          },
        },
      });
      const branchId = await createBranch(db);
      const parentId = await createSession(db, branchId, {
        agentic_tool: 'claude-code',
        created_by: user.user_id,
        permission_config: { mode: 'bypassPermissions' },
        model_config: { mode: 'exact', model: 'claude-parent-model', updated_at: 'now' },
      });
      const preset = await new AgenticToolPresetRepository(db).create(
        {
          tool: 'codex',
          name: 'Empty cross-tool child preset',
          configuration: {},
        },
        user.user_id
      );

      const service = new SessionsService(db, SPAWN_APP);
      const spawned = await service.spawn(parentId, {
        prompt: 'Do not inherit Claude values',
        agent: 'codex',
        presetId: preset.preset_id,
      });

      expect(spawned.permission_config).toEqual({
        mode: 'ask',
        codex: {
          sandboxMode: 'read-only',
          approvalPolicy: 'untrusted',
          networkAccess: false,
        },
      });
      expect(spawned.model_config?.model).toBe('personal-codex-model');
      expect(spawned.model_config?.model).not.toBe('claude-parent-model');

      const materialized = await runWithTenantContext('tenant-cross-tool-child', () =>
        service.materializeAgenticToolConfiguration(spawned)
      );
      expect(materialized.permission_config).toEqual(spawned.permission_config);
      expect(materialized.model_config?.model).toBe('personal-codex-model');
    }
  );

  dbTest('rejects reference plus inline values on create and spawn', async ({ db }) => {
    const preset = await new AgenticToolPresetRepository(db).create(
      { tool: 'codex', name: 'Exclusive source', configuration: {} },
      'test-user' as UUID
    );
    const branchId = await createBranch(db);
    const service = new SessionsService(db, SPAWN_APP);
    const parentId = await createSession(db, branchId, { agentic_tool: 'codex' });

    await expect(
      service.create({
        session_id: generateId(),
        branch_id: branchId,
        agentic_tool: 'codex',
        agentic_tool_preset_id: preset.preset_id,
        permission_config: { mode: 'ask' },
        status: SessionStatus.IDLE,
        created_by: 'test-user' as UUID,
        git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
        tasks: [],
        contextFiles: [],
        genealogy: { children: [] },
      } as never)
    ).rejects.toThrow(/reference.*inline/i);
    await expect(
      service.spawn(parentId, {
        prompt: 'Mixed intent',
        presetId: preset.preset_id,
        permissionMode: 'ask',
      } as never)
    ).rejects.toThrow(/reference.*inline/i);
  });

  for (const selectedSource of ['preset', 'workspace_default'] as const) {
    dbTest(
      `resolves quick-start user-default references through the saved OpenCode ${selectedSource}`,
      async ({ db }) => {
        const preset = await new AgenticToolPresetRepository(db).create(
          {
            tool: 'opencode',
            name: 'Saved quick-start default',
            is_default: selectedSource === 'workspace_default',
            configuration: {
              permissionMode: 'yolo',
              modelConfig: {
                mode: 'exact',
                provider: 'preset-provider',
                model: 'preset-model',
              },
            },
          },
          'test-user' as UUID
        );
        const user = await new UsersRepository(db).create({
          email: `quick-start-${generateId()}@example.com`,
          name: 'Quick-start owner',
          default_agentic_selection: {
            opencode:
              selectedSource === 'preset'
                ? { source: 'preset', preset_id: preset.preset_id }
                : { source: 'workspace_default' },
          },
          default_agentic_config: {
            opencode: {
              permissionMode: 'autoEdit',
              modelConfig: {
                mode: 'exact',
                provider: 'personal-provider',
                model: 'personal-model',
              },
            },
          },
        });
        const created = (await new SessionsService(db, STUB_APP).create(
          {
            session_id: generateId(),
            branch_id: await createBranch(db),
            agentic_tool: 'opencode',
            agentic_tool_preset_id: USER_DEFAULT_AGENTIC_CONFIGURATION,
            status: SessionStatus.IDLE,
            created_by: user.user_id,
            git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
            tasks: [],
            contextFiles: [],
            genealogy: { children: [] },
          },
          { user: { user_id: user.user_id } } as unknown as SessionParams
        )) as Session;

        expect(created).toMatchObject({
          agentic_tool_preset_id: preset.preset_id,
          permission_config: { mode: 'yolo' },
          model_config: {
            provider: 'preset-provider',
            model: 'preset-model',
          },
        });
      }
    );
  }

  dbTest(
    'resolves quick-start user-default references through an inline personal OpenCode default',
    async ({ db }) => {
      const user = await new UsersRepository(db).create({
        email: `quick-start-inline-${generateId()}@example.com`,
        name: 'Quick-start inline owner',
        default_agentic_config: {
          opencode: {
            permissionMode: 'yolo',
            modelConfig: {
              mode: 'exact',
              provider: 'personal-provider',
              model: 'personal-model',
            },
          },
        },
      });
      const created = (await new SessionsService(db, STUB_APP).create(
        {
          session_id: generateId(),
          branch_id: await createBranch(db),
          agentic_tool: 'opencode',
          agentic_tool_preset_id: USER_DEFAULT_AGENTIC_CONFIGURATION,
          status: SessionStatus.IDLE,
          created_by: user.user_id,
          git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
          tasks: [],
          contextFiles: [],
          genealogy: { children: [] },
        },
        { user: { user_id: user.user_id } } as unknown as SessionParams
      )) as Session;

      expect(created).toMatchObject({
        permission_config: { mode: 'yolo' },
        model_config: {
          provider: 'personal-provider',
          model: 'personal-model',
        },
      });
      expect(created.agentic_tool_preset_id).toBeFalsy();
    }
  );

  for (const tool of ['claude-code', 'codex'] as const) {
    dbTest(
      `falls through an empty ${tool} reference to the execution owner's defaults`,
      async ({ db }) => {
        const user = await new UsersRepository(db).create({
          email: `${tool}-${generateId()}@example.com`,
          name: `${tool} owner`,
          default_agentic_config: {
            [tool]: {
              modelConfig: { mode: 'exact', model: `personal-${tool}-model` },
              permissionMode: tool === 'codex' ? 'ask' : 'bypassPermissions',
              ...(tool === 'codex'
                ? {
                    codexSandboxMode: 'danger-full-access' as const,
                    codexApprovalPolicy: 'untrusted' as const,
                    codexNetworkAccess: false,
                  }
                : {}),
            },
          },
        });
        const preset = await new AgenticToolPresetRepository(db).create(
          {
            tool,
            name: `${tool} empty configuration`,
            configuration: {},
          },
          user.user_id
        );
        const branchId = await createBranch(db);

        const created = (await new SessionsService(db, STUB_APP).create({
          session_id: generateId(),
          branch_id: branchId,
          agentic_tool: tool,
          agentic_tool_preset_id: preset.preset_id,
          status: SessionStatus.IDLE,
          created_by: user.user_id,
          git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
          tasks: [],
          contextFiles: [],
          genealogy: { children: [] },
        })) as Session;

        expect(created.model_config?.model).toBe(`personal-${tool}-model`);
        expect(created.permission_config).toEqual(
          tool === 'codex'
            ? {
                mode: 'ask',
                codex: {
                  sandboxMode: 'danger-full-access',
                  approvalPolicy: 'untrusted',
                  networkAccess: false,
                },
              }
            : { mode: 'bypassPermissions' }
        );
      }
    );
  }
});
