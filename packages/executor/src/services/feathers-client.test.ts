import type { AgorClient } from '@agor/core/api';
import { SOCKET_IO_MAX_BUFFER_SIZE_BYTES } from '@agor/core/config';
import { describe, expect, it } from 'vitest';
import {
  EXECUTOR_REQUEST_DATA_BUDGET_BYTES,
  registerExecutorClientHooks,
} from './feathers-client.js';

describe('executor transport budget', () => {
  it('derives a budget below the shared Socket.IO ceiling', () => {
    expect(EXECUTOR_REQUEST_DATA_BUDGET_BYTES).toBe(800_000);
    expect(EXECUTOR_REQUEST_DATA_BUDGET_BYTES).toBeLessThan(SOCKET_IO_MAX_BUFFER_SIZE_BYTES);
  });
});

describe('registerExecutorClientHooks – size guard', () => {
  type HookFn = (ctx: Record<string, unknown>) => Promise<Record<string, unknown>>;

  function captureHook(onTerminalTaskAcknowledged?: () => void): {
    hook: HookFn;
    afterHook: HookFn;
    client: AgorClient;
  } {
    let hook: HookFn | undefined;
    let afterHook: HookFn | undefined;
    const client = {
      hooks(config: { before: { all: HookFn[] }; after: { all: HookFn[] } }) {
        hook = config.before.all[0];
        afterHook = config.after.all[0];
      },
    } as unknown as AgorClient;
    registerExecutorClientHooks(client, onTerminalTaskAcknowledged);
    if (!hook || !afterHook) throw new Error('hook was not registered');
    return { hook, afterHook, client };
  }

  function makeContext(path: string, method: string, data: unknown) {
    return { path, method, data };
  }

  function oversizedPayload(): string {
    return 'x'.repeat(EXECUTOR_REQUEST_DATA_BUDGET_BYTES + 1);
  }

  it('rejects oversized messages.create', async () => {
    const { hook } = captureHook();
    const ctx = makeContext('messages', 'create', { content: oversizedPayload() });
    await expect(hook(ctx)).rejects.toThrow(/transport budget/);
  });

  it('rejects oversized messages.patch', async () => {
    const { hook } = captureHook();
    const ctx = makeContext('messages', 'patch', { content: oversizedPayload() });
    await expect(hook(ctx)).rejects.toThrow(/transport budget/);
  });

  it('allows under-budget transcript payloads', async () => {
    const { hook } = captureHook();
    const ctx = makeContext('messages', 'create', { content: 'small' });
    const result = await hook(ctx);
    expect(result).toBe(ctx);
  });

  it('skips non-transcript paths', async () => {
    const { hook } = captureHook();
    const ctx = makeContext('sessions', 'create', { content: oversizedPayload() });
    const result = await hook(ctx);
    expect(result).toBe(ctx);
  });

  it('skips non-write methods on messages', async () => {
    const { hook } = captureHook();
    const ctx = makeContext('messages', 'find', { content: oversizedPayload() });
    const result = await hook(ctx);
    expect(result).toBe(ctx);
  });

  it('includes byte count and path in the error message', async () => {
    const { hook } = captureHook();
    const ctx = makeContext('messages', 'create', { content: oversizedPayload() });
    await expect(hook(ctx)).rejects.toThrow('messages.create');
  });

  it.each(['completed', 'failed'])(
    'suppresses revoked-credential reconnect only after an acknowledged %s Task patch',
    async (status) => {
      let acknowledgements = 0;
      const { afterHook } = captureHook(() => {
        acknowledgements += 1;
      });

      await afterHook({ ...makeContext('tasks', 'patch', { status }), result: { status } });
      expect(acknowledgements).toBe(1);

      await afterHook({ ...makeContext('tasks', 'get', { status }), result: { status } });
      await afterHook({
        ...makeContext('tasks', 'patch', { status: 'running' }),
        result: { status: 'running' },
      });
      expect(acknowledgements).toBe(1);
    }
  );
});
