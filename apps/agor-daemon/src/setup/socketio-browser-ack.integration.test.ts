import type { Server } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { afterEach, describe, expect, it, vi } from 'vitest';

function waitForSocketConnect(socketClient: AgorClient): Promise<void> {
  if (socketClient.io.connected) return Promise.resolve();
  return new Promise((resolve) => socketClient.io.once('connect', resolve));
}

describe('browser socket client acknowledgement on disconnect', () => {
  let server: Server | undefined;
  let client: AgorClient | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    client?.io.close();
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('rejects a call in flight when the socket drops instead of leaving it pending', async () => {
    const app = feathersExpress(feathers());
    app.use('stranded', {
      async get(id: string) {
        return { id };
      },
    });
    app.configure(
      socketio({}, (io) => {
        io.on('connection', (socket) => {
          socket.use((packet, next) => {
            const [event, path] = packet;
            if (event === 'get' && path === 'stranded') {
              // The request reaches the daemon, then the transport drops
              // before any acknowledgement is written.
              packet[packet.length - 1] = () => {};
              setImmediate(() => socket.disconnect(true));
            }
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

    // Construct the client the way a browser tab does: no explicit ackTimeout.
    vi.stubGlobal('window', {});
    client = createClient(`http://127.0.0.1:${address.port}`, false, { reconnectionAttempts: 0 });
    vi.unstubAllGlobals();
    client.io.connect();
    await waitForSocketConnect(client);

    const strandedService = (
      client as AgorClient & {
        service(path: 'stranded'): { get(id: string): Promise<unknown> };
      }
    ).service('stranded');
    const pending = Symbol('pending');
    const outcome = await Promise.race([
      strandedService.get('1').then(
        () => 'resolved',
        (error: Error) => error
      ),
      new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 2_000)),
    ]);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/disconnected/i);
  });
});
