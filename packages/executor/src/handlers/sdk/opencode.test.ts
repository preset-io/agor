import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
  createUserMessage: vi.fn(),
  messagesCreate: vi.fn(),
  taskMessagesFind: vi.fn(),
  nextMessageIndex: vi.fn(),
  branchFind: vi.fn(),
  permissionRegister: vi.fn(),
  permissionUnregister: vi.fn(),
  openCodeConstructor: vi.fn(),
  getMcpServersForSession: vi.fn(),
  tasksGet: vi.fn(),
  sessionsGet: vi.fn(),
}));

vi.mock('@agor/core/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/mcp')>()),
  getMcpServersForSession: mocks.getMcpServersForSession,
}));

const nativeState = vi.hoisted(() => ({
  prepare: vi.fn(async () => undefined),
  prune: vi.fn(async () => []),
  restore: vi.fn(async () => undefined),
  discard: vi.fn(async () => undefined),
}));

vi.mock('@agor/agentic-tool-opencode/runtime', () => ({
  isOpenCodeCleanupUnverifiedError: (error: unknown) =>
    error instanceof Error && error.name === 'OpenCodeCleanupUnverifiedError',
  OpenCodeTool: class {
    constructor(options: unknown) {
      mocks.openCodeConstructor(options);
    }
    runTurn = mocks.runTurn;
  },
  resolveOpenCodeNativeStateLayout: (input: { taskId: string }) => ({
    scratchRoot: `/scratch/${input.taskId}`,
    xdg: {
      data: `/scratch/${input.taskId}/xdg-data`,
      config: `/scratch/${input.taskId}/xdg-config`,
      cache: `/scratch/${input.taskId}/xdg-cache`,
      state: `/scratch/${input.taskId}/xdg-state`,
    },
    liveDbPath: `/scratch/${input.taskId}/opencode.db`,
    attemptsDir: '/home/user/attempts',
  }),
  prepareOpenCodeScratch: nativeState.prepare,
  pruneOpenCodeAttempts: nativeState.prune,
  restoreOpenCodeAcceptedState: nativeState.restore,
  discardOpenCodeScratch: nativeState.discard,
}));

vi.mock('../../db/feathers-repositories.js', () => ({
  createFeathersBackedRepositories: () => ({
    branches: { findById: mocks.branchFind },
    messages: {
      findInitialUserMessagesByTaskId: mocks.taskMessagesFind,
      getNextIndexBySessionId: mocks.nextMessageIndex,
    },
    messagesService: { create: mocks.messagesCreate },
    sessionMCP: {},
    mcpServers: {},
    mcpOAuthAuthHeaders: {},
    tasksService: { get: mocks.tasksGet },
    sessionsService: { get: mocks.sessionsGet },
  }),
}));

vi.mock('../../permissions/permission-service.js', () => ({
  PermissionService: class {},
}));

vi.mock('../../permissions/permission-manager.js', () => ({
  globalPermissionManager: {
    register: mocks.permissionRegister,
    unregister: mocks.permissionUnregister,
  },
}));

vi.mock('../../sdk-handlers/claude/message-builder.js', () => ({
  createUserMessage: mocks.createUserMessage,
}));

vi.mock('./base-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./base-executor.js')>()),
  createStreamingCallbacks: () => ({}),
}));

import { executeOpenCodeTask } from './opencode.js';

const sessionId = '00000000-0000-7000-8000-000000000001';
const taskId = '00000000-0000-7000-8000-000000000002';

function client(sessionOverrides: Record<string, unknown> = {}) {
  const services = {
    sessions: {
      get: vi.fn(async () => ({
        session_id: sessionId,
        branch_id: '00000000-0000-7000-8000-000000000003',
        title: 'OpenCode session',
        model_config: { mode: 'exact', provider: 'openai', model: 'gpt-test' },
        ...sessionOverrides,
      })),
      patch: vi.fn(async () => ({})),
      emit: vi.fn(),
    },
    tasks: { patch: vi.fn(async () => ({})) },
    messages: {
      find: vi.fn(async () => ({ total: 0, limit: 1, skip: 0, data: [] })),
      create: vi.fn(async () => ({})),
    },
    'config/resolve-api-key': {
      create: vi.fn(async () => ({
        apiKey: null,
        connection: { OPENCODE_API_KEY_ANTHROPIC: 'sk-ant-test' },
        source: 'user',
        useNativeAuth: false,
      })),
    },
  };
  return {
    services,
    value: { service: (name: keyof typeof services) => services[name] },
  };
}

const managedContext = {
  version: 2 as const,
  mode: 'managed-projection' as const,
  namespaceKey: 'e'.repeat(64),
  agorSessionId: sessionId,
  taskId,
  accepted: null,
};
const acceptedAttempt = {
  version: 1 as const,
  attemptTaskId: '01a08d5f-7773-77fa-a7dc-2575cfe6727f',
  digest: `sha256:${'a'.repeat(64)}`,
  bytes: 4096,
  openCodeSessionId: 'oc-accepted',
  publishedAt: '2026-09-10T22:18:55.000Z',
};

function execute(
  value: ReturnType<typeof client>['value'],
  abortController = new AbortController(),
  agenticToolContext: Record<string, unknown> = { dataHome: '/opaque/opencode-home' }
) {
  return executeOpenCodeTask({
    client: value as never,
    sessionId: sessionId as never,
    taskId: taskId as never,
    prompt: 'Continue',
    abortController,
    agenticToolContext,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.branchFind.mockResolvedValue({ path: '/worktree' });
  mocks.taskMessagesFind.mockResolvedValue([]);
  mocks.nextMessageIndex.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
  mocks.runTurn.mockResolvedValue({
    finalMessage: {
      content: 'done',
      contentBlocks: [{ type: 'text', text: 'done' }],
      toolUses: [],
      metadata: {},
    },
  });
  mocks.getMcpServersForSession.mockResolvedValue([]);
  mocks.tasksGet.mockResolvedValue({ created_by: 'task-creator' });
  mocks.sessionsGet.mockResolvedValue({ created_by: 'session-owner' });
});

describe('OpenCode executor adapter', () => {
  it('preserves the exact provider/model and native session across resume', async () => {
    const state = client({
      sdk_session_id: 'oc-existing',
      model_config: {
        mode: 'exact',
        provider: 'openai',
        model: 'gpt-test',
        effort: 'max',
      },
    });

    await execute(state.value);

    expect(mocks.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-test',
        effort: 'max',
        existingOpenCodeSessionId: 'oc-existing',
        dataHome: '/opaque/opencode-home',
      }),
      expect.anything()
    );
    expect(state.services.sessions.patch).not.toHaveBeenCalled();
    expect(state.services.tasks.patch).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ status: 'completed', model: 'openai/gpt-test' })
    );
  });

  it('hydrates and filters MCP definitions for the task creator', async () => {
    const state = client({ created_by: 'session-owner' });

    await execute(state.value);
    const options = mocks.openCodeConstructor.mock.calls[0][0] as {
      resolveMcpServers(sessionId: string): Promise<unknown>;
    };
    await options.resolveMcpServers(sessionId);

    expect(mocks.getMcpServersForSession).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        forUserId: 'task-creator',
      }),
      { toolFiltering: 'intercept' }
    );
  });

  it('persists a newly-created native session before completing the task', async () => {
    const order: string[] = [];
    const state = client();
    state.services.sessions.patch.mockImplementation(async () => {
      order.push('session');
      return {};
    });
    state.services.tasks.patch.mockImplementation(async () => {
      order.push('task');
      return {};
    });
    mocks.runTurn.mockImplementation(async (input) => {
      await input.persistOpenCodeSessionId('oc-created');
      order.push('turn-clean');
      return {
        finalMessage: {
          content: 'done',
          contentBlocks: [{ type: 'text', text: 'done' }],
          toolUses: [],
          metadata: {},
        },
      };
    });

    await execute(state.value);

    expect(state.services.sessions.patch).toHaveBeenCalledWith(sessionId, {
      sdk_session_id: 'oc-created',
    });
    expect(order).toEqual(['session', 'turn-clean', 'task']);
  });

  it('surfaces a provider failure in the task and transcript', async () => {
    const order: string[] = [];
    const state = client();
    state.services.messages.create.mockImplementation(async () => {
      order.push('message');
      return {};
    });
    state.services.tasks.patch.mockImplementation(async () => {
      order.push('task');
      return {};
    });
    mocks.runTurn.mockRejectedValue(new Error('OpenCode provider authentication failed'));

    await expect(execute(state.value)).rejects.toThrow('OpenCode provider authentication failed');

    expect(state.services.tasks.patch).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        status: 'failed',
        error_message: 'OpenCode provider authentication failed',
      })
    );
    expect(state.services.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: sessionId,
        task_id: taskId,
        type: 'system',
        role: 'system',
        content: 'OpenCode provider authentication failed',
        metadata: { is_task_failure: true },
      })
    );
    expect(order).toEqual(['message', 'task']);
  });

  it('rejects a missing exact pair before provider side effects', async () => {
    const state = client({ model_config: { mode: 'exact', provider: 'openai', model: '' } });

    await expect(execute(state.value)).rejects.toThrow(/provider and model/i);

    expect(mocks.branchFind).not.toHaveBeenCalled();
    expect(mocks.createUserMessage).not.toHaveBeenCalled();
    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(state.services.tasks.patch).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ status: 'failed' })
    );
  });

  it('leaves cleanup-unverified work active for daemon containment', async () => {
    const state = client();
    const failure = new Error('private runtime detail');
    failure.name = 'OpenCodeCleanupUnverifiedError';
    mocks.runTurn.mockRejectedValue(failure);

    await expect(execute(state.value)).resolves.toBeUndefined();

    expect(state.services.tasks.patch).not.toHaveBeenCalled();
    expect(state.services.messages.create).not.toHaveBeenCalled();
    expect(mocks.permissionUnregister).toHaveBeenCalledWith(sessionId);
  });

  it('does not make an aborted turn terminal', async () => {
    const state = client();
    const abortController = new AbortController();
    abortController.abort();
    mocks.runTurn.mockRejectedValue(new Error('cancelled'));

    await expect(execute(state.value, abortController)).rejects.toThrow('cancelled');

    expect(state.services.tasks.patch).not.toHaveBeenCalled();
    expect(state.services.messages.create).not.toHaveBeenCalled();
  });
});

describe('OpenCode executor adapter (hosted managed projection)', () => {
  it('pulls reviewed keys through the task-scoped read, restores the accepted checkpoint, and publishes with completion', async () => {
    const state = client({
      sdk_session_id: 'oc-stale-unpublished',
      model_config: { mode: 'exact', provider: 'anthropic', model: 'claude-test' },
    });
    const published = {
      ...acceptedAttempt,
      attemptTaskId: taskId,
      openCodeSessionId: 'oc-accepted',
    };
    mocks.runTurn.mockResolvedValueOnce({
      openCodeSessionId: 'oc-accepted',
      sessionWasCreated: false,
      nativeStateAttempt: published,
      finalMessage: { content: 'done', contentBlocks: [], toolUses: [], metadata: {} },
    });

    await execute(state.value, new AbortController(), {
      ...managedContext,
      accepted: acceptedAttempt,
    });

    expect(state.services['config/resolve-api-key'].create).toHaveBeenCalledWith({
      taskId,
      keyName: 'OPENCODE_API_KEY_ANTHROPIC',
      tool: 'opencode',
    });
    expect(nativeState.prepare).toHaveBeenCalledOnce();
    expect(nativeState.prune).toHaveBeenCalledWith(expect.anything(), acceptedAttempt);
    expect(nativeState.restore).toHaveBeenCalledWith(expect.anything(), acceptedAttempt);
    const turn = mocks.runTurn.mock.calls[0][0] as {
      existingOpenCodeSessionId?: string;
      dataHome?: string;
      managed?: { authContent?: string; authSecrets: string[]; accepted: unknown };
    };
    expect(turn.existingOpenCodeSessionId).toBe('oc-accepted');
    expect(turn.dataHome).toBeUndefined();
    expect(JSON.parse(turn.managed?.authContent ?? '{}')).toEqual({
      anthropic: { type: 'api', key: 'sk-ant-test' },
    });
    expect(turn.managed?.authSecrets).toContain('sk-ant-test');
    expect(process.env.OPENCODE_API_KEY_ANTHROPIC).toBeUndefined();
    expect(process.env.OPENCODE_AUTH_CONTENT).toBeUndefined();
    expect(state.services.sessions.patch).not.toHaveBeenCalled();
    expect(state.services.tasks.patch).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ status: 'completed', native_state_attempt: published })
    );
    expect(nativeState.discard).toHaveBeenCalledOnce();
  });

  it('fails the turn as a missing credential when no reviewed key is saved', async () => {
    const state = client({ model_config: { mode: 'exact', provider: 'anthropic', model: 'm' } });
    state.services['config/resolve-api-key'].create.mockResolvedValueOnce({
      apiKey: null,
      connection: {},
      source: 'none',
      useNativeAuth: false,
    });

    await expect(execute(state.value, new AbortController(), managedContext)).rejects.toThrow(
      /No OpenCode provider key is saved/
    );
    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(state.services.tasks.patch).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ status: 'failed' })
    );
  });

  it('refuses a managed context that names another task and a turn without a checkpoint', async () => {
    const state = client({ model_config: { mode: 'exact', provider: 'anthropic', model: 'm' } });
    await expect(
      execute(state.value, new AbortController(), {
        ...managedContext,
        taskId: '01a08d5f-7773-77fa-a7dc-2575cfe6727f',
      })
    ).rejects.toThrow(/does not belong to this task/);
    expect(mocks.runTurn).not.toHaveBeenCalled();

    mocks.runTurn.mockResolvedValueOnce({
      openCodeSessionId: 'oc-new',
      sessionWasCreated: true,
      finalMessage: { content: 'done', contentBlocks: [], toolUses: [], metadata: {} },
    });
    const second = client({ model_config: { mode: 'exact', provider: 'anthropic', model: 'm' } });
    await expect(execute(second.value, new AbortController(), managedContext)).rejects.toThrow(
      /without a published checkpoint/
    );
    expect(second.services.tasks.patch).not.toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ status: 'completed' })
    );
  });
});
