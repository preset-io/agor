import type { Server } from 'node:http';
import type { AgorClient } from '@agor/core/api';
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecutorClient } from '../../../../packages/executor/src/services/feathers-client.js';

const SESSION_TOKEN = 'executor-session-token';

interface RecordedCall {
  path: string;
  method: 'create' | 'patch';
  data: unknown;
}

interface GenericService {
  create(data: unknown): Promise<unknown>;
  patch(id: string, data: unknown): Promise<unknown>;
}

function service(client: AgorClient, path: string): GenericService {
  return (client as unknown as { service(path: string): GenericService }).service(path);
}

function executorAuthenticationService() {
  return {
    async create(data: { accessToken?: string }) {
      return {
        accessToken: data.accessToken ?? SESSION_TOKEN,
        authentication: { strategy: 'jwt' },
        user: { user_id: 'executor-user' },
      };
    },
  };
}

describe('executor transcript application hook', () => {
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

  it('projects create, patch, and bulk create while leaving other operations untouched', async () => {
    const app = feathersExpress(feathers());
    const calls: RecordedCall[] = [];
    const recordingService = (path: string) => ({
      async create(data: unknown) {
        calls.push({ path, method: 'create' as const, data });
        return data;
      },
      async patch(_id: string, data: unknown) {
        calls.push({ path, method: 'patch' as const, data });
        return data;
      },
    });
    for (const path of ['messages', 'messages/bulk', 'messages/streaming', 'other']) {
      app.use(path, recordingService(path));
    }
    app.use('authentication', executorAuthenticationService());
    app.configure(socketio());

    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');

    client = await createExecutorClient(`http://127.0.0.1:${address.port}`, SESSION_TOKEN);

    const oversizedMessage = (id: string) => ({
      message_id: id,
      content: [
        {
          type: 'tool_result',
          tool_use_id: `tool-${id}`,
          content: `${id}-HEAD_${'x'.repeat(1_100_000)}_${id}-TAIL`,
        },
      ],
    });
    await service(client, 'messages').create(oversizedMessage('create'));
    await service(client, 'messages').patch('patch-id', oversizedMessage('patch'));
    await service(client, 'messages/bulk').create([oversizedMessage('bulk')]);

    const untouchedStreaming = {
      event: 'streaming:chunk',
      data: oversizedMessage('streaming-under-budget').content[0],
    };
    const untouchedOther = oversizedMessage('other-under-budget');
    untouchedStreaming.data.content = 'streaming result';
    untouchedOther.content[0].content = 'other result';
    await service(client, 'messages/streaming').create(untouchedStreaming);
    await service(client, 'other').create(untouchedOther);

    expect(calls).toHaveLength(5);
    for (const call of calls.slice(0, 3)) {
      const message = Array.isArray(call.data) ? call.data[0] : call.data;
      expect(message).toMatchObject({
        content: [
          {
            content: expect.stringContaining('Middle omitted from transcript storage'),
            transcript_projection: {
              truncated: true,
              original_content_bytes: expect.any(Number),
              persisted_content_bytes: expect.any(Number),
            },
          },
        ],
      });
    }
    expect(calls[3].data).toEqual(untouchedStreaming);
    expect(calls[4].data).toEqual(untouchedOther);
  });

  it('rejects irreducible and unserializable data before invoking the transport', async () => {
    const app = feathersExpress(feathers());
    let createCount = 0;
    app.use('messages', {
      async create(data: unknown) {
        createCount += 1;
        return data;
      },
    });
    app.use('authentication', executorAuthenticationService());
    app.configure(socketio());
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');

    client = await createExecutorClient(`http://127.0.0.1:${address.port}`, SESSION_TOKEN);

    await expect(
      service(client, 'messages').create({ ordinary_text: 'x'.repeat(800_000) })
    ).rejects.toThrow(/exceeding the 800000-byte budget/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(service(client, 'messages').create(cyclic)).rejects.toThrow(
      /could not be serialized/
    );
    expect(createCount).toBe(0);
  });
});
