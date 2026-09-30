import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
  prepare: vi.fn(),
  discard: vi.fn(async () => undefined),
}));

vi.mock('@agor/agentic-tool-opencode/runtime', () => ({
  assertOpenCodeCheckpointRuntime: vi.fn(async () => undefined),
  discardOpenCodeScratch: mocks.discard,
  resolveOpenCodeNativeStateLayout: (input: unknown) => ({ layoutFor: input }),
  prepareOpenCodeScratch: mocks.prepare,
  restoreOpenCodeCheckpoint: mocks.restore,
  removeOpenCodeCheckpoints: mocks.remove,
}));

vi.mock('./base-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./base-executor.js')>()),
  resolveApiKeyForTask: mocks.resolveApiKey,
}));

import { completeManagedOpenCodeTurn, prepareManagedOpenCodeTurn } from './opencode-managed.js';

const sessionId = '00000000-0000-7000-8000-000000000001' as never;
const taskId = '00000000-0000-7000-8000-000000000002' as never;
const accepted = { version: 1, taskId: 'prior', openCodeSessionId: 'ses_1' };
const stale = { sessionId: '00000000-0000-7000-8000-000000000001', taskId: 'old' };

function client(begin: unknown) {
  const tasks = {
    beginOpenCodeCheckpoint: vi.fn(async () => begin),
    acknowledgeOpenCodeCleanup: vi.fn(async () => undefined),
    get: vi.fn(),
    patch: vi.fn(),
  };
  return { tasks, value: { service: () => tasks } as never };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue({
    connection: { OPENCODE_API_KEY_OPENAI: 'sk-owner' },
    source: 'user',
  });
  mocks.remove.mockImplementation(async (_layout, objects) => objects);
});

describe('prepareManagedOpenCodeTurn', () => {
  it('returns null for a duplicate executor before reading any credential', async () => {
    const state = client({ outcome: 'duplicate' });
    await expect(
      prepareManagedOpenCodeTurn({ client: state.value, sessionId, taskId, provider: 'openai' })
    ).resolves.toBeNull();
    expect(mocks.resolveApiKey).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('projects only the owner key for the selected curated provider', async () => {
    const state = client({ outcome: 'admitted', input: accepted, cleanup: [stale] });
    const turn = await prepareManagedOpenCodeTurn({
      client: state.value,
      sessionId,
      taskId,
      provider: 'openai',
    });

    expect(mocks.resolveApiKey).toHaveBeenCalledWith(
      'OPENCODE_API_KEY_OPENAI',
      state.value,
      taskId,
      'opencode'
    );
    expect(JSON.parse(turn?.authContent ?? '{}')).toEqual({
      openai: { type: 'api', key: 'sk-owner' },
    });
    expect(turn?.authSecrets).toContain('sk-owner');
    expect(mocks.restore).toHaveBeenCalledWith(expect.anything(), accepted);
    expect(state.tasks.acknowledgeOpenCodeCleanup).toHaveBeenCalledWith({
      task_id: taskId,
      holder_instance_id: turn?.holderId,
      deleted: [stale],
    });
  });

  it('discards scratch when the saved conversation cannot be restored', async () => {
    mocks.restore.mockRejectedValueOnce(new Error('saved conversation failed verification'));
    await expect(
      prepareManagedOpenCodeTurn({
        client: client({ outcome: 'admitted', input: accepted, cleanup: [] }).value,
        sessionId,
        taskId,
        provider: 'openai',
      })
    ).rejects.toThrow(/failed verification/);
    expect(mocks.discard).toHaveBeenCalledOnce();
  });

  it('refuses providers outside the curated set and missing keys', async () => {
    await expect(
      prepareManagedOpenCodeTurn({
        client: client({ outcome: 'admitted', input: null, cleanup: [] }).value,
        sessionId,
        taskId,
        provider: 'openrouter',
      })
    ).rejects.toThrow(/not available in hosted workspaces/);
    mocks.resolveApiKey.mockResolvedValue({ connection: {}, source: 'none' });
    await expect(
      prepareManagedOpenCodeTurn({
        client: client({ outcome: 'admitted', input: null, cleanup: [] }).value,
        sessionId,
        taskId,
        provider: 'anthropic',
      })
    ).rejects.toThrow(/Save an API key for anthropic/);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});

describe('completeManagedOpenCodeTurn', () => {
  const turn = { holderId: 'holder' } as never;
  const manifest = { version: 1 } as never;

  it('treats a Task already read back as completed as accepted after a lost response', async () => {
    vi.useFakeTimers();
    try {
      const state = client(undefined);
      state.tasks.get
        .mockResolvedValueOnce({ status: 'running' })
        .mockResolvedValueOnce({ status: 'completed' });
      state.tasks.patch.mockRejectedValueOnce(new Error('socket closed'));
      const done = completeManagedOpenCodeTurn(
        state.value,
        taskId,
        { status: 'completed' },
        turn,
        manifest
      );
      await vi.runAllTimersAsync();
      await expect(done).resolves.toBeUndefined();
      expect(state.tasks.patch).toHaveBeenCalledOnce();
      expect(state.tasks.patch).toHaveBeenCalledWith(taskId, {
        status: 'completed',
        opencode_checkpoint: { holder_instance_id: 'holder', manifest },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
