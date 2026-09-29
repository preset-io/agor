// TCP-level link emulator for the slow-network benchmark.
//
// CDP's Network.emulateNetworkConditions shapes HTTP requests but does not
// reliably shape WebSocket frames, and nearly all Agor data rides the
// Socket.IO WebSocket. This proxy sits between Chromium and the daemon and
// shapes *every* byte instead:
//
// - one shared FIFO link per direction (down/up) with a fixed bandwidth, so
//   parallel connections compete for the same pipe the way they do on a VPN;
// - a fixed one-way propagation delay (RTT / 2) per direction;
// - `handshakeRtts` extra round trips before a new connection's first byte
//   (1 = TCP, 2 = TCP + TLS 1.3), since the browser's local connect is free.
//
// It also counts the bytes each direction actually carried, which is the
// post-compression "bytes over the wire" figure (HTTP bodies *and* WS frames).

import net from 'node:net';

const SLICE = 16 * 1024;

class Link {
  constructor(bitsPerSecond, oneWayMs) {
    this.bytesPerMs = bitsPerSecond / 8 / 1000;
    this.oneWayMs = oneWayMs;
    this.busyUntil = 0;
    this.bytes = 0;
    this.chunks = 0;
  }

  send(chunk, deliver) {
    for (let off = 0; off < chunk.length; off += SLICE) {
      const piece = chunk.subarray(off, off + SLICE);
      const now = performance.now();
      const start = Math.max(now, this.busyUntil);
      this.busyUntil = start + piece.length / this.bytesPerMs;
      this.bytes += piece.length;
      this.chunks++;
      const at = this.busyUntil + this.oneWayMs;
      setTimeout(() => deliver(piece), Math.max(0, at - now));
    }
  }
}

/**
 * @param {{ listenPort: number, targetPort: number, targetHost?: string, rttMs: number, downMbps: number, upMbps: number, handshakeRtts?: number }} opts
 */
export async function startThrottleProxy(opts) {
  const {
    listenPort,
    targetPort,
    targetHost = 'localhost',
    rttMs,
    downMbps,
    upMbps,
    handshakeRtts = 2,
  } = opts;
  const down = new Link(downMbps * 1e6, rttMs / 2);
  const up = new Link(upMbps * 1e6, rttMs / 2);
  const sockets = new Set();
  let connections = 0;
  let lastActivity = performance.now();

  let blocked = false;
  const server = net.createServer((client) => {
    // While "offline", refuse new connections the way an unreachable host does.
    if (blocked) {
      client.destroy();
      return;
    }
    connections++;
    const upstream = net.connect(targetPort, targetHost);
    sockets.add(client);
    sockets.add(upstream);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    // Simulated connection setup: nothing reaches the server until the
    // handshake round trips have elapsed.
    // This is per connection: it must not occupy the shared uplink.
    const writeUp = (piece) => upstream.writable && upstream.write(piece);
    let pending = [];
    setTimeout(() => {
      for (const chunk of pending) up.send(chunk, writeUp);
      pending = null;
    }, handshakeRtts * rttMs);
    client.on('data', (chunk) => {
      lastActivity = performance.now();
      if (pending) pending.push(chunk);
      else up.send(chunk, writeUp);
    });
    upstream.on('data', (chunk) => {
      lastActivity = performance.now();
      down.send(chunk, (piece) => client.writable && client.write(piece));
    });
    const close = () => {
      // Let queued slices drain before closing the other side.
      const drainAt = Math.max(down.busyUntil, up.busyUntil) + rttMs;
      setTimeout(
        () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        },
        Math.max(0, drainAt - performance.now())
      );
    };
    client.on('close', close);
    upstream.on('close', close);
    client.on('error', close);
    upstream.on('error', close);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '::', resolve);
  });

  return {
    stats() {
      return {
        bytesDown: down.bytes,
        bytesUp: up.bytes,
        connections,
        lastActivity,
      };
    },
    /** Simulate a VPN blip: drop every open connection at once. */
    dropAll() {
      for (const socket of sockets) socket.destroy();
    },
    /** While true, new connections are refused (the link is down). */
    setBlocked(value) {
      blocked = value;
    },
    reset() {
      down.bytes = 0;
      up.bytes = 0;
      connections = 0;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
