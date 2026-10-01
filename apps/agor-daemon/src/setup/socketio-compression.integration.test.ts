import type { Server } from 'node:http';
import type { Socket as NetSocket } from 'node:net';
import { type AgorClient, createClient } from '@agor/core/api';
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { afterEach, describe, expect, it } from 'vitest';
import { SOCKET_IO_PER_MESSAGE_DEFLATE } from './socketio.js';

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

  async function bytesToFetchSnapshot(serverOptions: object) {
    const app = feathersExpress(feathers());
    const snapshot = listSnapshot(2_000);
    app.use('snapshots', {
      async find() {
        return snapshot;
      },
    });
    app.configure(socketio(serverOptions));

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
    return { wire: written() - before, json: JSON.stringify(snapshot).length };
  }

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
