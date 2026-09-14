import { feathers } from '@agor/core/feathers';
import type { HookContext, Message, MessageID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { protectExternalWidgetMessageWrites } from './message-boundary';

const externalParams = { provider: 'rest' } as never;
const executorParams = {
  provider: 'socketio',
  authentication: {
    strategy: 'jwt',
    payload: {
      type: 'executor-session',
      purpose: 'executor-task',
      task_id: 'task-1',
      session_id: 'session-1',
    },
  },
} as never;

function widgetMessage(status: 'pending' | 'resolving' | 'submitted'): Message {
  const messageId = 'widget-message' as MessageID;
  return {
    message_id: messageId,
    session_id: 'session-1' as never,
    type: 'widget_request',
    role: MessageRole.SYSTEM,
    index: 0,
    timestamp: '2026-08-06T00:00:00.000Z',
    content_preview: 'Resolve',
    content: 'Resolve',
    metadata: {
      widget: {
        widget_id: messageId,
        widget_type: 'test',
        schema_version: 1,
        params: {},
        status,
        requested_at: '2026-08-06T00:00:00.000Z',
        ...(status === 'resolving'
          ? {
              resolution_claim: {
                token: 'claim-token',
                action: 'submit' as const,
                claimed_at: '2026-08-06T00:00:01.000Z',
                claimed_by: 'user-1' as never,
              },
            }
          : {}),
      },
    },
  };
}

function ordinaryMessage(): Message {
  return {
    message_id: 'ordinary-message' as MessageID,
    session_id: 'session-1' as never,
    type: 'user',
    role: MessageRole.USER,
    index: 1,
    timestamp: '2026-08-06T00:00:02.000Z',
    content_preview: 'hello',
    content: 'hello',
  };
}

function makeTransportService(seed: Message[]) {
  const rows = new Map(seed.map((message) => [message.message_id as string, message]));
  const app = feathers();
  app.use('messages', {
    async create(data: Message) {
      rows.set(data.message_id, data);
      return data;
    },
    async update(id: string, data: Partial<Message>) {
      const next = { ...rows.get(id)!, ...data } as Message;
      rows.set(id, next);
      return next;
    },
    async patch(id: string, data: Partial<Message>) {
      const next = { ...rows.get(id)!, ...data } as Message;
      rows.set(id, next);
      return next;
    },
    async remove(id: string) {
      const current = rows.get(id)!;
      rows.delete(id);
      return current;
    },
  } as never);
  const service = app.service('messages') as unknown as {
    hooks(hooks: {
      before: Record<
        'create' | 'update' | 'patch' | 'remove',
        Array<(context: HookContext) => Promise<HookContext>>
      >;
    }): void;
    create(data: Message, params?: unknown): Promise<Message>;
    update(id: string, data: Partial<Message>, params?: unknown): Promise<Message>;
    patch(id: string, data: Partial<Message>, params?: unknown): Promise<Message>;
    remove(id: string, params?: unknown): Promise<Message>;
  };
  const boundary = protectExternalWidgetMessageWrites(async (id) => rows.get(id) ?? null);
  service.hooks({
    before: {
      create: [boundary],
      update: [boundary],
      patch: [boundary],
      remove: [boundary],
    },
  });
  return { rows, service };
}

describe('external widget Message boundary', () => {
  let pending: Message;
  let resolving: Message;

  beforeEach(() => {
    pending = widgetMessage('pending');
    resolving = { ...widgetMessage('resolving'), message_id: 'resolving-widget' as MessageID };
  });

  it('rejects transport creation of widget messages and widget metadata', async () => {
    const { service } = makeTransportService([]);
    await expect(service.create(pending, externalParams)).rejects.toThrow(
      'only be created by the daemon'
    );
    await expect(service.create(pending, executorParams)).rejects.toThrow(
      'only be created by the daemon'
    );
    await expect(
      service.create(
        {
          ...ordinaryMessage(),
          metadata: pending.metadata,
        },
        externalParams
      )
    ).rejects.toThrow('only be created by the daemon');
  });

  it('rejects transport attempts to reset or replace a live widget claim', async () => {
    const { rows, service } = makeTransportService([pending, resolving]);
    await expect(
      service.patch(
        resolving.message_id,
        {
          metadata: {
            widget: { ...resolving.metadata!.widget!, status: 'pending' },
          },
        },
        externalParams
      )
    ).rejects.toThrow('daemon-owned');
    await expect(service.update(resolving.message_id, pending, externalParams)).rejects.toThrow(
      'not available to external callers'
    );
    expect(rows.get(resolving.message_id)?.metadata?.widget?.status).toBe('resolving');
  });

  it('rejects removal while pending or resolving but permits terminal cleanup', async () => {
    const terminal = widgetMessage('submitted');
    terminal.message_id = 'terminal-widget' as MessageID;
    const { rows, service } = makeTransportService([pending, resolving, terminal]);

    await expect(service.remove(pending.message_id, externalParams)).rejects.toThrow(
      'cannot be removed externally'
    );
    await expect(service.remove(resolving.message_id, externalParams)).rejects.toThrow(
      'cannot be removed externally'
    );
    await expect(service.remove(terminal.message_id, externalParams)).resolves.toMatchObject({
      message_id: terminal.message_id,
    });
    expect(rows.has(terminal.message_id)).toBe(false);
  });

  it('keeps ordinary patching and trusted internal widget work available', async () => {
    const ordinary = ordinaryMessage();
    const { rows, service } = makeTransportService([ordinary, pending]);

    await expect(
      service.patch(ordinary.message_id, { content: 'edited' }, externalParams)
    ).resolves.toMatchObject({ content: 'edited' });
    await expect(
      service.patch(pending.message_id, { content: 'daemon projection' })
    ).resolves.toMatchObject({ content: 'daemon projection' });
    expect(rows.get(pending.message_id)?.content).toBe('daemon projection');
  });
});
