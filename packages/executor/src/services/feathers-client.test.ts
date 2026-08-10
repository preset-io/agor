import type { AgorClient } from '@agor/core/api';
import { SOCKET_IO_MAX_BUFFER_SIZE_BYTES } from '@agor/core/config';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { createSingleFlight } from './feathers-auth-retry.js';
import {
  EXECUTOR_REQUEST_DATA_BUDGET_BYTES,
  registerExecutorClientHooks,
  reportSdkHealthFailureWithAckTimeout,
} from './feathers-client.js';

function sdkHealthInput() {
  return {
    task_id: 'task-1' as never,
    reason: 'no_first_progress' as const,
    elapsed_ms: 1,
    watchdog_action: 'enforced' as const,
    pulse_sequence_at_detection: 1,
  };
}

function authenticationFailure(): Error {
  return Object.assign(new Error('jwt expired'), {
    name: 'NotAuthenticated',
    code: 401,
    className: 'not-authenticated',
  });
}

describe('executor transport budget', () => {
  it('derives a budget below the shared Socket.IO ceiling', () => {
    expect(EXECUTOR_REQUEST_DATA_BUDGET_BYTES).toBe(800_000);
    expect(EXECUTOR_REQUEST_DATA_BUDGET_BYTES).toBeLessThan(SOCKET_IO_MAX_BUFFER_SIZE_BYTES);
  });
});

describe('SDK-health transport', () => {
  it('uses a request-local Socket.IO acknowledgement timeout', async () => {
    const emit = vi.fn(
      (
        _method: string,
        _path: string,
        _data: unknown,
        _query: unknown,
        callback: (timeoutError: unknown, error: unknown, data: unknown) => void
      ) => callback(null, null, { task_id: 'task-1' })
    );
    const timeout = vi.fn(() => ({ emit }));
    const client = { io: { timeout } } as unknown as AgorClient;

    await expect(
      reportSdkHealthFailureWithAckTimeout(client, sdkHealthInput(), 2_000)
    ).resolves.toEqual({ task_id: 'task-1' });

    expect(timeout).toHaveBeenCalledWith(2_000);
    expect(emit).toHaveBeenCalledWith(
      'reportSdkHealthFailure',
      'tasks',
      expect.objectContaining({ task_id: 'task-1' }),
      {},
      expect.any(Function)
    );
  });

  it('rejects when the bounded acknowledgement expires', async () => {
    const timeoutError = new Error('operation has timed out');
    const emit = vi.fn(
      (
        _method: string,
        _path: string,
        _data: unknown,
        _query: unknown,
        callback: (timeoutError: unknown, error: unknown, data: unknown) => void
      ) => callback(timeoutError, null, undefined)
    );
    const client = { io: { timeout: () => ({ emit }) } } as unknown as AgorClient;

    await expect(
      reportSdkHealthFailureWithAckTimeout(client, sdkHealthInput(), 2_000)
    ).rejects.toThrow('timed out');
  });

  it('ignores an acknowledgement that arrives after the timeout callback', async () => {
    let callback!: (timeoutError: unknown, error: unknown, data: unknown) => void;
    const emit = vi.fn((...args: unknown[]) => {
      callback = args.at(-1) as typeof callback;
    });
    const client = { io: { timeout: () => ({ emit }) } } as unknown as AgorClient;
    const report = reportSdkHealthFailureWithAckTimeout(client, sdkHealthInput(), 2_000);

    const rejection = expect(report).rejects.toThrow('timed out');
    callback(new Error('operation has timed out'), null, undefined);
    callback(null, null, { task_id: 'task-1', status: TaskStatus.STOPPING });

    await rejection;
  });

  it('shares the existing single-flight reauthentication owner and retries each bounded call once', async () => {
    let releaseReauthentication!: () => void;
    const reauthenticate = vi.fn(
      () => new Promise<boolean>((resolve) => (releaseReauthentication = () => resolve(true)))
    );
    const singleFlight = createSingleFlight(reauthenticate);
    let callIndex = 0;
    const emit = vi.fn(
      (
        _method: string,
        _path: string,
        _data: unknown,
        _query: unknown,
        callback: (timeoutError: unknown, error: unknown, data: unknown) => void
      ) => {
        const current = callIndex++;
        if (current < 2) callback(null, authenticationFailure(), undefined);
        else callback(null, null, { task_id: `task-${current}`, status: TaskStatus.STOPPING });
      }
    );
    const client = {
      io: { timeout: () => ({ emit }) },
      executorReauthenticate: singleFlight,
    } as unknown as AgorClient;

    const reports = [
      reportSdkHealthFailureWithAckTimeout(client, sdkHealthInput(), 2_000),
      reportSdkHealthFailureWithAckTimeout(client, sdkHealthInput(), 2_000),
    ];
    await vi.waitFor(() => expect(reauthenticate).toHaveBeenCalledOnce());
    releaseReauthentication();

    await expect(Promise.all(reports)).resolves.toEqual([
      expect.objectContaining({ status: TaskStatus.STOPPING }),
      expect.objectContaining({ status: TaskStatus.STOPPING }),
    ]);
    expect(reauthenticate).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledTimes(4);
  });

  it('does not loop when the bounded retry is also rejected as unauthenticated', async () => {
    const emit = vi.fn(
      (
        _method: string,
        _path: string,
        _data: unknown,
        _query: unknown,
        callback: (timeoutError: unknown, error: unknown, data: unknown) => void
      ) => callback(null, authenticationFailure(), undefined)
    );
    const reauthenticate = vi.fn().mockResolvedValue(true);
    const client = {
      io: { timeout: () => ({ emit }) },
      executorReauthenticate: reauthenticate,
    } as unknown as AgorClient;

    await expect(
      reportSdkHealthFailureWithAckTimeout(client, sdkHealthInput(), 2_000)
    ).rejects.toMatchObject({ code: 401 });
    expect(reauthenticate).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledTimes(2);
  });
});

describe('registerExecutorClientHooks – size guard', () => {
  type HookFn = (ctx: Record<string, unknown>) => Promise<Record<string, unknown>>;

  function captureHook(): { hook: HookFn; client: AgorClient } {
    let hook: HookFn | undefined;
    const client = {
      hooks(config: { before: { all: HookFn[] } }) {
        hook = config.before.all[0];
      },
    } as unknown as AgorClient;
    registerExecutorClientHooks(client);
    if (!hook) throw new Error('hook was not registered');
    return { hook, client };
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

  it('rejects oversized messages/bulk.create', async () => {
    const { hook } = captureHook();
    const ctx = makeContext('messages/bulk', 'create', { items: [oversizedPayload()] });
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
});
