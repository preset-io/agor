import type { Server } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { type Session, SessionStatus, type Task, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BaseTool,
  executeToolTask,
} from '../../../../packages/executor/src/handlers/sdk/base-executor.js';
import { registerExecutorClientHooks } from '../../../../packages/executor/src/services/feathers-client.js';
import { TasksService } from '../services/tasks.js';

const TASK_ID = '018f0000-0000-7000-8000-000000000001';
const SESSION_ID = '018f0000-0000-7000-8000-000000000002';

function waitForSocketConnect(client: AgorClient): Promise<void> {
  if (client.io.connected) return Promise.resolve();
  return new Promise((resolve) => client.io.once('connect', resolve));
}

describe('executor acknowledgement failure convergence', () => {
  let server: Server | undefined;
  let client: AgorClient | undefined;

  afterEach(async () => {
    client?.io.close();
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('rejects a stranded mutation once and converges through the executor terminal boundary', async () => {
    const app = feathersExpress(feathers());
    let mutationCount = 0;
    let shouldStrandAcknowledgement = true;
    let session = {
      session_id: SESSION_ID,
      status: SessionStatus.RUNNING,
      ready_for_prompt: false,
      tasks: [TASK_ID],
    } as Session;
    let task = {
      task_id: TASK_ID,
      session_id: SESSION_ID,
      status: TaskStatus.RUNNING,
      created_at: '2026-07-13T12:00:00.000Z',
      full_prompt: 'Exercise a stranded acknowledgement',
    } as Task;

    app.use('lost-ack', {
      async create(data: { value: string }) {
        mutationCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return data;
      },
    });
    const taskService = Object.create(TasksService.prototype) as TasksService & {
      app: typeof app;
      get: (id: string) => Promise<Task>;
      repository: { update: (id: string, data: Partial<Task>) => Promise<Task> };
      id: string;
      emit: () => boolean;
    };
    taskService.app = app;
    taskService.get = async () => task;
    taskService.repository = {
      async update(_id, data) {
        task = { ...task, ...data };
        return task;
      },
    };
    taskService.id = 'task_id';
    taskService.emit = () => false;
    app.use('tasks', taskService);
    app.use('sessions', {
      async get() {
        return session;
      },
      async patch(_id: string, data: Partial<Session>) {
        session = { ...session, ...data };
        return session;
      },
      async triggerQueueProcessing() {},
    });
    app.use('config/resolve-api-key', {
      async create() {
        return { apiKey: 'test-key', source: 'global', useNativeAuth: false };
      },
    });
    app.use('messages', {
      async find() {
        return { total: 0, limit: 10, skip: 0, data: [] };
      },
      async create(data: unknown) {
        return data;
      },
    });

    app.configure(
      socketio({}, (io) => {
        io.on('connection', (socket) => {
          socket.use((packet, next) => {
            const [event, path] = packet;
            if (event !== 'create' || path !== 'lost-ack' || !shouldStrandAcknowledgement) {
              next();
              return;
            }
            shouldStrandAcknowledgement = false;
            packet[packet.length - 1] = () => {};
            next();
          });
        });
      })
    );

    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');

    client = createClient(`http://127.0.0.1:${address.port}`, true, {
      ackTimeout: 100,
      reconnectionAttempts: 3,
    });
    registerExecutorClientHooks(client);
    await waitForSocketConnect(client);

    let rejection: unknown;
    const startedAt = Date.now();
    try {
      await executeToolTask({
        client,
        sessionId: SESSION_ID as never,
        taskId: TASK_ID as never,
        prompt: 'Exercise a stranded acknowledgement',
        abortController: new AbortController(),
        apiKeyEnvVar: 'OPENAI_API_KEY',
        toolName: 'codex',
        createTool: () =>
          ({
            async executePromptWithStreaming() {
              await (
                client as AgorClient & {
                  service(path: 'lost-ack'): {
                    create(data: { value: string }): Promise<unknown>;
                  };
                }
              )
                .service('lost-ack')
                .create({ value: 'sub-limit' });
              throw new Error('Unreachable after the stranded acknowledgement');
            },
          }) satisfies BaseTool,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    client.io.disconnect().connect();
    await waitForSocketConnect(client);
    expect(mutationCount).toBe(1);

    expect(task).toMatchObject({
      status: TaskStatus.FAILED,
      error_message: expect.any(String),
    });
    expect(task.error_message).toBe((rejection as Error).message);
    expect(task.error_message).toMatch(/timed out/i);
    expect(session).toMatchObject({ status: SessionStatus.FAILED, ready_for_prompt: true });
  });
});
