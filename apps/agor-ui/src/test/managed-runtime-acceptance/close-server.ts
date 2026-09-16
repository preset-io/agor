/** Test-only listener ownership. Node's closeAllConnections does not close upgrades. */
import type { Server, Socket } from 'node:net';

export function ownAcceptanceServerConnections(server: Server) {
  const sockets = new Set<Socket>();
  const accept = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  // Install before the fixture exposes its address to browsers/proxies.
  server.on('connection', accept);
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= new Promise<void>((resolve, reject) => {
      server.close((error: NodeJS.ErrnoException | undefined) => {
        server.off('connection', accept);
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
      // Only this fixture's sockets, after its tests have completed. Stop new
      // accepts first, then close HTTP and upgraded proxy connections alike.
      for (const socket of sockets) socket.destroy();
    });
    return closing;
  };
}
