import type { Server } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { type Task, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { tryMarkTaskTerminal } from '../../../../packages/executor/src/terminal-task.js';

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
    let session = { status: 'running', ready_for_prompt: false };
    let task = {
      task_id: TASK_ID,
      session_id: SESSION_ID,
      status: TaskStatus.RUNNING,
      created_at: '2026-07-13T12:00:00.000Z',
    } as unknown as Task;

    app.use('lost-ack', {
      async create(data: { value: string }) {
        mutationCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return data;
      },
    });
    app.use('tasks', {
      async get() {
        return task;
      },
      async patch(_id: string, data: Partial<Task>) {
        task = { ...task, ...data };
        if (data.status === TaskStatus.FAILED) {
          session = { status: 'failed', ready_for_prompt: true };
        }
        return task;
      },
    });

    app.configure(
      socketio({}, (io) => {
        io.on('connection', (socket) => {
          socket.onAny((event, path) => {
            if (event !== 'create' || path !== 'lost-ack' || !shouldStrandAcknowledgement) return;
            shouldStrandAcknowledgement = false;
            setTimeout(() => socket.conn.close(), 5);
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
    await waitForSocketConnect(client);

    let rejection: unknown;
    const startedAt = Date.now();
    try {
      await (
        client as AgorClient & {
          service(path: 'lost-ack'): { create(data: { value: string }): Promise<unknown> };
        }
      )
        .service('lost-ack')
        .create({ value: 'sub-limit' });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    await waitForSocketConnect(client);
    expect(mutationCount).toBe(1);

    await tryMarkTaskTerminal(
      client,
      TASK_ID,
      TaskStatus.FAILED,
      rejection instanceof Error ? rejection.message : String(rejection)
    );

    expect(task).toMatchObject({
      status: TaskStatus.FAILED,
      error_message: expect.any(String),
    });
    expect(task.error_message).toBe((rejection as Error).message);
    expect(task.error_message?.length).toBeGreaterThan(0);
    expect(session).toEqual({ status: 'failed', ready_for_prompt: true });
  });
});
