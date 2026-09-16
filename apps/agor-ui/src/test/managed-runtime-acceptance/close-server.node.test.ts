// @vitest-environment node
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { expect, it } from 'vitest';
import { ownAcceptanceServerConnections } from './close-server';

it('closes its own upgraded proxy sockets without waiting for the peer', async () => {
  const server = createServer();
  const close = ownAcceptanceServerConnections(server);
  server.on('upgrade', (_request, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n'
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing owned listener');
  const client = connect(address.port, '127.0.0.1');
  try {
    await once(client, 'connect');
    client.write(
      'GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n'
    );
    const [response] = await once(client, 'data');
    expect(String(response)).toContain('101 Switching Protocols');
    const closed = once(client, 'close');
    await close();
    await closed;
    await close();
    expect(server.listening).toBe(false);
  } finally {
    client.destroy();
    await close();
  }
}, 5000);
