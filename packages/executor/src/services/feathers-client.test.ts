import type { AgorClient } from '@agor/core/api';
import { SOCKET_IO_MAX_BUFFER_SIZE_BYTES } from '@agor/core/config';
import { describe, expect, it } from 'vitest';
import {
  EXECUTOR_REQUEST_DATA_BUDGET_BYTES,
  registerExecutorRequestSizeGuard,
  registerTerminalTaskAcknowledgementHook,
} from './feathers-client.js';

describe('executor transport budget', () => {
  it('derives a budget below the shared Socket.IO ceiling', () => {
    expect(EXECUTOR_REQUEST_DATA_BUDGET_BYTES).toBe(800_000);
    expect(EXECUTOR_REQUEST_DATA_BUDGET_BYTES).toBeLessThan(SOCKET_IO_MAX_BUFFER_SIZE_BYTES);
  });
});

describe('executor client hooks', () => {
  type HookFn = (ctx: Record<string, unknown>) => Promise<Record<string, unknown>>;

  function captureHook(onTerminalTaskAcknowledged?: () => void): {
    hook: HookFn;
    afterHook: HookFn;
    client: AgorClient;
  } {
    let hook: HookFn | undefined;
    let afterHook: HookFn | undefined;
    const client = {
      hooks(config: { before?: { all: HookFn[] }; after?: { all: HookFn[] } }) {
        hook ??= config.before?.all[0];
        afterHook ??= config.after?.all[0];
      },
    } as unknown as AgorClient;
    registerExecutorRequestSizeGuard(client);
    registerTerminalTaskAcknowledgementHook(client, onTerminalTaskAcknowledged ?? (() => {}));
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

  it.each(['create', 'patch'])(
    'projects the complete %s wrapper at the exact byte boundary',
    async (method) => {
      const { hook } = captureHook();
      const data = {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: '', is_error: false }],
        content_preview: 'preview',
        metadata: { model: 'synthetic' },
      };
      const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
      data.content[0].content = 'x'.repeat(EXECUTOR_REQUEST_DATA_BUDGET_BYTES - size(data));
      expect(size(data)).toBe(EXECUTOR_REQUEST_DATA_BUDGET_BYTES);
      expect((await hook(makeContext('messages', method, data))).data).toBe(data);
      data.content_preview += '😀';
      expect(size(data.content)).toBeLessThan(EXECUTOR_REQUEST_DATA_BUDGET_BYTES);
      const result = await hook(makeContext('messages', method, data));
      expect(size(result.data)).toBeLessThanOrEqual(EXECUTOR_REQUEST_DATA_BUDGET_BYTES);
      expect(result.data).not.toBe(data);
      expect(JSON.stringify(result.data)).toContain('transcript_truncation');
    }
  );

  it('bounds the combined bulk-create data, including array overhead', async () => {
    const { hook } = captureHook();
    const data = [1, 2].map((id) => ({
      content: [
        {
          type: 'tool_use',
          id: `t${id}`,
          name: 'apply_patch',
          input: { patch: 'x'.repeat(450_000) },
        },
      ],
    }));
    const result = await hook(makeContext('messages', 'create', data));
    expect(Buffer.byteLength(JSON.stringify(result.data), 'utf8')).toBeLessThanOrEqual(
      EXECUTOR_REQUEST_DATA_BUDGET_BYTES
    );
    expect(data[0].content[0].input.patch).toHaveLength(450_000);
  });

  it('does not rewrite authority or foreign resource IDs while projecting', async () => {
    const { hook } = captureHook();
    const params = {
      tenant: { tenant_id: 'tenant-a' },
      authentication: { strategy: 'jwt', payload: { tenant_id: 'tenant-a' } },
    };
    const data = {
      session_id: 'foreign-session',
      task_id: 'foreign-task',
      content: [
        { type: 'tool_use', id: 't1', name: 'apply_patch', input: { patch: oversizedPayload() } },
      ],
    };
    const ctx = { ...makeContext('messages', 'create', data), id: 'foreign-message', params };
    const result = await hook(ctx);
    expect(result.params).toBe(params);
    expect(result.id).toBe('foreign-message');
    expect(result.data).toMatchObject({ session_id: 'foreign-session', task_id: 'foreign-task' });
    // The existing authenticated daemon boundary must still reject these IDs;
    // projection neither substitutes an authorized parent nor changes authority.
  });

  it('keeps the guard for irreducible wrappers and unserializable data', async () => {
    const { hook } = captureHook();
    await expect(
      hook(
        makeContext('messages', 'patch', {
          content: [],
          metadata: { diagnostic: oversizedPayload() },
        })
      )
    ).rejects.toThrow(/transport budget/);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(hook(makeContext('messages', 'create', cyclic))).rejects.toThrow(
      /could not be serialized/
    );
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
