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
  SessionRepository,
  TaskRepository,
  TenantAgenticToolSettingsRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Session, Task, UUID } from '@agor/core/types';
import {
  SessionStatus,
  TaskStatus,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { SessionsService } from './sessions';

// The guard only touches the session/task repos built from `db`; the stored
// `app` is never read on this path. A bare cast keeps the harness minimal.
const STUB_APP = {} as unknown as Application;
const TEST_USER_ID = '00000000-0000-7000-8000-000000000001' as UUID;

async function createBranch(db: any): Promise<UUID> {
  await new UsersRepository(db).create({
    user_id: TEST_USER_ID,
    email: `session-guard-${generateId()}@example.com`,
    name: 'Test User',
  });
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
    created_by: TEST_USER_ID,
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
    created_by: TEST_USER_ID,
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
    created_by: TEST_USER_ID,
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
          created_by: TEST_USER_ID,
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
      created_by: TEST_USER_ID,
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

  dbTest('uses catalog fallback only for unresolved default references', async ({ db }) => {
    const findCatalog = vi.fn(async () => ({
      suggestedSelection: { providerId: 'openai', modelId: 'gpt-test' },
    }));
    const app = {
      service: (path: string) => {
        if (path === 'opencode-models') {
          return { find: findCatalog };
        }
        throw new Error(`Unexpected service: ${path}`);
      },
    } as unknown as Application;
    const service = new SessionsService(db, app);
    const branchId = await createBranch(db);
    const user = await new UsersRepository(db).create({
      email: `catalog-fallback-${generateId()}@example.com`,
      name: 'Catalog fallback owner',
    });
    const defaultsBefore = {
      default_agentic_config: user.default_agentic_config,
      default_agentic_selection: user.default_agentic_selection,
    };

    for (const agenticToolPresetId of [
      undefined,
      USER_DEFAULT_AGENTIC_CONFIGURATION,
      WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
    ]) {
      const created = await service.create(
        {
          branch_id: branchId,
          agentic_tool: 'opencode',
          ...(agenticToolPresetId === undefined
            ? {}
            : { agentic_tool_preset_id: agenticToolPresetId }),
          status: SessionStatus.IDLE,
          created_by: user.user_id,
        },
        { user } as never
      );

      expect(created).toMatchObject({
        model_config: {
          mode: 'exact',
          provider: 'openai',
          model: 'gpt-test',
        },
      });
    }
    const reloadedUser = await new UsersRepository(db).findById(user.user_id);
    expect({
      default_agentic_config: reloadedUser?.default_agentic_config,
      default_agentic_selection: reloadedUser?.default_agentic_selection,
    }).toEqual(defaultsBefore);
    expect(findCatalog).toHaveBeenCalledTimes(3);
    const preset = await new AgenticToolPresetRepository(db).create(
      {
        tool: 'opencode',
        name: 'Incomplete preset',
        configuration: { modelConfig: modelConfig() },
      },
      user.user_id
    );

    await expect(
      service.create(
        {
          branch_id: branchId,
          agentic_tool: 'opencode',
          agentic_tool_preset_id: preset.preset_id,
          status: SessionStatus.IDLE,
          created_by: user.user_id,
        },
        { user } as never
      )
    ).rejects.toThrow(/provider and model/i);
    expect(findCatalog).toHaveBeenCalledTimes(3);
  });

  dbTest('materializes selected user and workspace presets on direct create', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const owner = await new UsersRepository(db).create({
      email: `direct-default-${generateId()}@example.com`,
      name: 'Direct default owner',
    });
    const presets = new AgenticToolPresetRepository(db);
    const userPreset = await presets.create(
      {
        tool: 'opencode',
        name: 'User selected',
        configuration: {
          permissionMode: 'auto',
          modelConfig: { mode: 'exact', provider: 'anthropic', model: 'claude-user' },
        },
      },
      owner.user_id
    );
    await new UsersRepository(db).update(owner.user_id, {
      default_agentic_selection: {
        opencode: { source: 'preset', preset_id: userPreset.preset_id },
      },
    });

    await expect(
      service.create({
        branch_id: branchId,
        agentic_tool: 'opencode',
        status: SessionStatus.IDLE,
        created_by: owner.user_id,
      })
    ).resolves.toMatchObject({
      agentic_tool_preset_id: userPreset.preset_id,
      permission_config: { mode: 'autoEdit' },
      model_config: { provider: 'anthropic', model: 'claude-user' },
    });

    const workspacePreset = await presets.create(
      {
        tool: 'opencode',
        name: 'Workspace selected',
        is_default: true,
        configuration: {
          modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-workspace' },
        },
      },
      owner.user_id
    );
    await new UsersRepository(db).update(owner.user_id, {
      default_agentic_selection: { opencode: { source: 'workspace_default' } },
    });

    await expect(
      service.create({
        branch_id: branchId,
        agentic_tool: 'opencode',
        status: SessionStatus.IDLE,
        created_by: owner.user_id,
      })
    ).resolves.toMatchObject({
      agentic_tool_preset_id: workspacePreset.preset_id,
      model_config: { provider: 'openai', model: 'gpt-workspace' },
    });
  });

  dbTest('never resolves a fallback under a different execution owner', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const owner = await new UsersRepository(db).create({
      email: `different-owner-${generateId()}@example.com`,
      name: 'Different owner',
    });

    await expect(
      service.create(
        {
          branch_id: branchId,
          agentic_tool: 'opencode',
          status: SessionStatus.IDLE,
          created_by: owner.user_id,
        },
        { user: { user_id: 'caller' as UUID } } as never
      )
    ).rejects.toThrow(/provider and model/i);
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
        created_by: TEST_USER_ID,
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

  dbTest(
    'allows trusted resolved creates but fails closed for incomplete children',
    async ({ db }) => {
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
        created_by: TEST_USER_ID,
        model_config: incompleteModel,
      };

      await expect(service.create(base, { _agenticConfigResolved: true })).rejects.toThrow(
        /provider and model/i
      );
      await expect(
        service.create(
          {
            ...base,
            agentic_tool_preset_id: USER_DEFAULT_AGENTIC_CONFIGURATION,
            model_config: modelConfig('openai'),
          },
          { _agenticConfigResolved: true }
        )
      ).rejects.toThrow(/preset.*resolved/i);

      const parentId = await createSession(db, branchId, {
        agentic_tool: 'opencode',
        model_config: incompleteModel,
      });
      await expect(service.fork(parentId, { prompt: 'Fork internally' })).rejects.toThrow(
        /provider and model/i
      );
      await expect(service.spawn(parentId, { prompt: 'Spawn without a task ID' })).rejects.toThrow(
        /provider and model/i
      );
    }
  );

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

  dbTest('materializes presets with explicit MCPs before taskless child trust', async ({ db }) => {
    const app = {
      service: (path: string) => {
        if (path === 'users') {
          return { get: (id: string) => new UsersRepository(db).findById(id) };
        }
        throw new Error(`Unexpected service: ${path}`);
      },
    } as unknown as Application;
    const service = new SessionsService(db, app);
    const setMCPServers = vi.spyOn(service, 'setMCPServers').mockResolvedValue();
    const branchId = await createBranch(db);
    const owner = await new UsersRepository(db).create({
      email: `child-owner-${generateId()}@example.com`,
      name: 'Child owner',
    });
    const preset = await new AgenticToolPresetRepository(db).create(
      {
        tool: 'opencode',
        name: 'Child exact pair',
        configuration: {
          modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-child' },
        },
      },
      owner.user_id
    );
    const parentId = await createSession(db, branchId, {
      agentic_tool: 'opencode',
      agentic_tool_preset_id: preset.preset_id,
      model_config: modelConfig(),
    });

    const explicitMcpServerIds = ['mcp-explicit'];
    const child = await service.spawn(parentId, {
      prompt: 'Taskless child',
      presetId: preset.preset_id,
      mcpServerIds: explicitMcpServerIds,
    });
    expect(child).toMatchObject({
      agentic_tool_preset_id: preset.preset_id,
      model_config: { mode: 'exact', provider: 'openai', model: 'gpt-child' },
      genealogy: { spawn_point_task_id: undefined },
    });
    expect(setMCPServers).toHaveBeenCalledWith(child.session_id, explicitMcpServerIds, 'spawn');
    await expect(service.fork(parentId, { prompt: 'Preset fork' })).resolves.toMatchObject({
      agentic_tool_preset_id: preset.preset_id,
      model_config: { mode: 'exact', provider: 'openai', model: 'gpt-child' },
    });

    await new UsersRepository(db).update(owner.user_id, {
      default_agentic_selection: {
        opencode: { source: 'preset', preset_id: preset.preset_id },
      },
    });
    const claudeParentId = await createSession(db, branchId, {
      created_by: owner.user_id,
      agentic_tool: 'claude-code',
    });
    await expect(
      service.spawn(claudeParentId, {
        prompt: 'Taskless cross-tool default',
        agent: 'opencode',
      })
    ).resolves.toMatchObject({
      agentic_tool_preset_id: preset.preset_id,
      model_config: { mode: 'exact', provider: 'openai', model: 'gpt-child' },
      genealogy: { spawn_point_task_id: undefined },
    });

    await new UsersRepository(db).update(owner.user_id, {
      default_agentic_config: {
        opencode: {
          modelConfig: { mode: 'exact', provider: 'anthropic', model: 'default-child' },
        },
      },
      default_agentic_selection: { opencode: { source: 'inline' } },
    });
    const ownedParentId = await createSession(db, branchId, {
      created_by: owner.user_id,
      agentic_tool: 'opencode',
      model_config: modelConfig('openai', 'stale-parent'),
    });
    await expect(
      service.spawn(ownedParentId, {
        prompt: 'Taskless reserved default',
        presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
      })
    ).resolves.toMatchObject({
      model_config: { mode: 'exact', provider: 'anthropic', model: 'default-child' },
      genealogy: { spawn_point_task_id: undefined },
    });
  });
});

describe('SessionsService built-in workload configuration boundary', () => {
  async function enableWorkload(db: any): Promise<void> {
    await new TenantAgenticToolSettingsRepository(db).patch('workload', { enabled: true });
  }

  dbTest('rejects preset, model, and permission configuration on create', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const base = {
      branch_id: branchId,
      agentic_tool: 'workload' as const,
      status: SessionStatus.IDLE,
      created_by: TEST_USER_ID,
    };

    for (const configured of [
      { agentic_tool_preset_id: generateId() },
      { model_config: { mode: 'exact', provider: 'openai', model: 'gpt-test' } },
      { permission_config: { mode: 'autoEdit' } },
    ]) {
      await expect(service.create({ ...base, ...configured } as never)).rejects.toThrow(
        /does not support presets, models, or permission configuration/i
      );
    }
  });

  dbTest(
    'rejects built-in configuration on patch, including internal preset application',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const sessionId = await createSession(db, branchId, { agentic_tool: 'workload' });

      await expect(
        service.patch(
          sessionId,
          { model_config: { mode: 'exact', provider: 'openai', model: 'gpt-test' } } as never,
          { _applyingAgenticToolPreset: true } as never
        )
      ).rejects.toThrow(/does not support presets, models, or permission configuration/i);
    }
  );

  dbTest(
    'atomically clears inline provider configuration when switching a taskless session',
    async ({ db }) => {
      await enableWorkload(db);
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const sessionId = await createSession(db, branchId, {
        agentic_tool: 'codex',
        agentic_tool_preset_id: null,
        model_config: {
          mode: 'exact',
          model: 'gpt-5-codex',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        permission_config: {
          mode: 'autoEdit',
          codex: {
            sandboxMode: 'workspace-write',
            approvalPolicy: 'on-request',
            networkAccess: true,
          },
        },
      });

      await expect(service.patch(sessionId, { agentic_tool: 'workload' })).resolves.toMatchObject({
        agentic_tool: 'workload',
        agentic_tool_preset_id: null,
        model_config: null,
        permission_config: null,
      });
      const persisted = await new SessionRepository(db).findById(sessionId);
      expect(persisted?.agentic_tool).toBe('workload');
      expect(persisted?.agentic_tool_preset_id).toBeUndefined();
      expect(persisted?.model_config).toBeUndefined();
      expect(persisted?.permission_config).toBeNull();
    }
  );

  dbTest(
    'clears a taskless preset-backed provider session when switching to workload',
    async ({ db }) => {
      await enableWorkload(db);
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const preset = await new AgenticToolPresetRepository(db).create(
        {
          tool: 'opencode',
          name: 'Provider preset to clear',
          configuration: {
            permissionMode: 'auto',
            modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-provider' },
          },
        },
        TEST_USER_ID
      );
      const sessionId = await createSession(db, branchId, {
        agentic_tool: 'opencode',
        agentic_tool_preset_id: preset.preset_id,
        model_config: {
          mode: 'exact',
          provider: 'openai',
          model: 'gpt-provider',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        permission_config: { mode: 'autoEdit' },
      });

      await expect(service.patch(sessionId, { agentic_tool: 'workload' })).resolves.toMatchObject({
        agentic_tool: 'workload',
        agentic_tool_preset_id: null,
        model_config: null,
        permission_config: null,
      });
    }
  );

  dbTest(
    'does not let the internal preset path preserve provider configuration on a workload switch',
    async ({ db }) => {
      await enableWorkload(db);
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const preset = await new AgenticToolPresetRepository(db).create(
        {
          tool: 'claude-code',
          name: 'Internal provider preset to clear',
          configuration: {
            permissionMode: 'plan',
            modelConfig: { mode: 'exact', model: 'claude-provider' },
          },
        },
        TEST_USER_ID
      );
      const sessionId = await createSession(db, branchId, {
        agentic_tool: 'claude-code',
        agentic_tool_preset_id: preset.preset_id,
        model_config: {
          mode: 'exact',
          model: 'claude-provider',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        permission_config: { mode: 'plan' },
      });

      await expect(
        service.patch(sessionId, { agentic_tool: 'workload' }, {
          _applyingAgenticToolPreset: true,
        } as never)
      ).resolves.toMatchObject({
        agentic_tool: 'workload',
        agentic_tool_preset_id: null,
        model_config: null,
        permission_config: null,
      });
    }
  );
});
