import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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

function turnInput(state: ReturnType<typeof client>) {
  return { client: state.value, sessionId, taskId, sdkHomeScope: 'execution_home' as const };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.remove.mockImplementation(async (_layout, objects) => objects);
});

describe('prepareManagedOpenCodeTurn', () => {
  it('returns null for a duplicate executor before reading any credential', async () => {
    const state = client({ outcome: 'duplicate' });
    await expect(
      prepareManagedOpenCodeTurn({ ...turnInput(state), provider: 'openai' })
    ).resolves.toBeNull();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('writes the admitted prompter key for the selected provider only', async () => {
    const state = client({
      outcome: 'admitted',
      input: accepted,
      cleanup: [stale],
      providerKey: { providerId: 'openai', key: 'sk-owner' },
    });
    const turn = await prepareManagedOpenCodeTurn({
      ...turnInput(state),
      provider: 'openai',
    });

    expect(JSON.parse(turn?.authContent ?? '{}')).toEqual({
      openai: { type: 'api', key: 'sk-owner' },
    });
    expect(turn?.authSecrets).toContain('sk-owner');
    expect(turn?.layout).toEqual({
      layoutFor: { sessionId, taskId, sdkHomeScope: 'execution_home' },
    });
    expect(mocks.restore).toHaveBeenCalledWith(expect.anything(), accepted);
    // The daemon accepts only UUIDv7 holder ids.
    expect(turn?.holderId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
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
        client: client({
          outcome: 'admitted',
          input: accepted,
          cleanup: [],
          providerKey: { providerId: 'openai', key: 'k' },
        }).value,
        sessionId,
        taskId,
        sdkHomeScope: 'execution_home',
        provider: 'openai',
      })
    ).rejects.toThrow(/failed verification/);
    expect(mocks.discard).toHaveBeenCalledOnce();
  });

  it('refuses a turn without a usable saved key before touching scratch', async () => {
    await expect(
      prepareManagedOpenCodeTurn({
        ...turnInput(client({ outcome: 'admitted', input: null, cleanup: [] })),
        provider: 'anthropic',
      })
    ).rejects.toThrow(/No usable API key for anthropic/);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('refuses a key delivered for a different provider than the one this turn runs', async () => {
    await expect(
      prepareManagedOpenCodeTurn({
        client: client({
          outcome: 'admitted',
          input: null,
          cleanup: [],
          providerKey: { providerId: 'openai', key: 'sk-other' },
        }).value,
        sessionId,
        taskId,
        sdkHomeScope: 'execution_home',
        provider: 'anthropic',
      })
    ).rejects.toThrow(/No usable API key for anthropic/);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});

describe('completeManagedOpenCodeTurn', () => {
  const turn = { holderId: 'holder' } as never;
  const manifest = { version: 1 } as never;

  it('treats a Task read back as completed as accepted and re-patches it to repair credential retirement', async () => {
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
      expect(state.tasks.patch).toHaveBeenCalledTimes(2);
      expect(state.tasks.patch).toHaveBeenNthCalledWith(1, taskId, {
        status: 'completed',
        opencode_checkpoint: { holder_instance_id: 'holder', manifest },
      });
      // Re-patching without the checkpoint lets the service repair credential retirement.
      expect(state.tasks.patch).toHaveBeenNthCalledWith(2, taskId, { status: 'completed' });
    } finally {
      vi.useRealTimers();
    }
  });
});
