import type { Server } from 'node:http';
import type { Socket as NetSocket } from 'node:net';
import { type AgorClient, createClient } from '@agor/core/api';
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { afterEach, describe, expect, it } from 'vitest';
import { createSocketIOConfig, SOCKET_IO_PER_MESSAGE_DEFLATE } from './socketio.js';

function waitForSocketConnect(socketClient: AgorClient): Promise<void> {
  if (socketClient.io.connected) return Promise.resolve();
  return new Promise((resolve) => socketClient.io.once('connect', resolve));
}

// Shaped like a workspace list snapshot: many rows with repeated keys.
function listSnapshot(rows: number) {
  return Array.from({ length: rows }, (_, index) => ({
    session_id: `018f0000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    branch_id: '018f0000-0000-7000-8000-000000000001',
    status: 'idle',
    agentic_tool: 'claude-code',
    title: `Session ${index}`,
    model_config: { mode: 'alias', model: 'claude-sonnet-4-5', effort: 'high' },
    archived: false,
  }));
}

describe('Socket.IO WebSocket compression', () => {
  let server: Server | undefined;
  let client: AgorClient | undefined;

  afterEach(async () => {
    client?.io.close();
    client = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve()))
      );
      server = undefined;
    }
  });

  async function bytesToFetchSnapshot(
    serverOptions: object | ((app: ReturnType<typeof feathersExpress>) => object)
  ) {
    const app = feathersExpress(feathers());
    const snapshot = listSnapshot(2_000);
    app.use('snapshots', {
      async find() {
        return snapshot;
      },
    });
    app.configure(
      socketio(typeof serverOptions === 'function' ? serverOptions(app) : serverOptions)
    );

    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const tcpSockets: NetSocket[] = [];
    server.on('connection', (socket: NetSocket) => tcpSockets.push(socket));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');

    client = createClient(`http://127.0.0.1:${address.port}`, true, { reconnectionAttempts: 0 });
    await waitForSocketConnect(client);

    const written = () => tcpSockets.reduce((total, socket) => total + socket.bytesWritten, 0);
    const before = written();
    const rows = (await client.service('snapshots').find()) as unknown[];
    expect(rows).toHaveLength(snapshot.length);
    // What the client's `ws` transport negotiated in the upgrade handshake.
    const transport = client.io.io.engine.transport as unknown as {
      ws?: { extensions?: string };
    };
    return {
      wire: written() - before,
      json: JSON.stringify(snapshot).length,
      extensions: transport.ws?.extensions ?? '',
    };
  }

  // The daemon's real server options (no auth callback is needed to observe
  // the WebSocket handshake), with `daemon.websocket_compression` on or off.
  const daemonServerOptions =
    (websocketCompression?: boolean) => (app: ReturnType<typeof feathersExpress>) => ({
      ...createSocketIOConfig(app as never, {
        corsOrigin: true,
        credentialsAllowed: false,
        ...(websocketCompression === undefined ? {} : { websocketCompression }),
      }).serverOptions,
      transports: ['websocket'],
    });

  it('negotiates permessage-deflate by default and when the switch is on', async () => {
    for (const setting of [undefined, true]) {
      const { wire, json, extensions } = await bytesToFetchSnapshot(daemonServerOptions(setting));
      expect(extensions).toContain('permessage-deflate');
      expect(wire).toBeLessThan(json / 4);
      client?.io.close();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it('negotiates no compression when daemon.websocket_compression is false', async () => {
    const { wire, json, extensions } = await bytesToFetchSnapshot(daemonServerOptions(false));

    expect(extensions).not.toContain('permessage-deflate');
    expect(wire).toBeGreaterThanOrEqual(json);
  });

  it('compresses large responses on the wire and leaves them intact for the client', async () => {
    const { wire, json } = await bytesToFetchSnapshot({
      transports: ['websocket'],
      perMessageDeflate: SOCKET_IO_PER_MESSAGE_DEFLATE,
    });

    expect(wire).toBeLessThan(json / 4);
  });

  it('sends the same response uncompressed without the option (baseline)', async () => {
    const { wire, json } = await bytesToFetchSnapshot({ transports: ['websocket'] });

    expect(wire).toBeGreaterThanOrEqual(json);
  });
});
