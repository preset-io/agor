import { feathers } from '@agor/core/feathers';
import type { HookContext, Message, MessageID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { protectExternalPermissionMessageWrites } from './permission-message-boundary.js';

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

function permissionMessage(): Message {
  return {
    message_id: 'permission-message' as MessageID,
    session_id: 'session-1' as never,
    task_id: 'task-1' as never,
    type: 'permission_request',
    role: MessageRole.SYSTEM,
    index: 2,
    timestamp: '2026-08-06T00:00:03.000Z',
    content_preview: 'Permission required: Bash',
    content: {
      request_id: 'request-1',
      task_id: 'task-1' as never,
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
      status: 'pending' as never,
    },
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
        'create' | 'patch' | 'remove',
        Array<(context: HookContext) => Promise<HookContext>>
      >;
    }): void;
    create(data: Message, params?: unknown): Promise<Message>;
    patch(id: string, data: Partial<Message>, params?: unknown): Promise<Message>;
    remove(id: string, params?: unknown): Promise<Message>;
  };
  const boundary = protectExternalPermissionMessageWrites(async (id) => rows.get(id) ?? null);
  service.hooks({
    before: {
      create: [boundary],
      patch: [boundary],
      remove: [boundary],
    },
  });
  return { rows, service };
}

describe('external permission Message boundary', () => {
  it('keeps permission display and outcome fields executor-owned', async () => {
    const permission = permissionMessage();
    const { rows, service } = makeTransportService([permission]);

    await expect(service.create(permission, externalParams)).rejects.toThrow(
      'task-scoped executor'
    );
    await expect(
      service.patch(
        permission.message_id,
        { content: { ...permission.content, tool_input: { command: 'rm -rf /' } } },
        externalParams
      )
    ).rejects.toThrow('task-scoped executor');
    await expect(service.remove(permission.message_id, externalParams)).rejects.toThrow(
      'task-scoped executor'
    );

    await expect(service.create(permission, executorParams)).resolves.toMatchObject({
      type: 'permission_request',
    });
    await expect(
      service.patch(
        permission.message_id,
        { content: { ...permission.content, status: 'approved' as never } },
        executorParams
      )
    ).resolves.toMatchObject({
      content: expect.objectContaining({ status: 'approved' }),
    });
    expect(rows.get(permission.message_id)?.content).toMatchObject({ status: 'approved' });
  });

  it('rejects permission writes attributed to another task or session', async () => {
    const permission = permissionMessage();
    const { service } = makeTransportService([permission]);
    const otherTask = {
      ...executorParams,
      authentication: {
        ...executorParams.authentication,
        payload: { ...executorParams.authentication.payload, task_id: 'task-2' },
      },
    } as never;
    const otherSession = {
      ...executorParams,
      authentication: {
        ...executorParams.authentication,
        payload: { ...executorParams.authentication.payload, session_id: 'session-2' },
      },
    } as never;

    await expect(service.create(permission, otherTask)).rejects.toThrow('task-scoped executor');
    await expect(
      service.patch(permission.message_id, { content: permission.content }, otherTask)
    ).rejects.toThrow('task-scoped executor');
    await expect(service.remove(permission.message_id, otherSession)).rejects.toThrow(
      'task-scoped executor'
    );
  });
});
