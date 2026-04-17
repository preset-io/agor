/**
 * Trust-proxy wiring test.
 *
 * Verifies that Express's `req.ip` resolution honours our `trust proxy`
 * setting. We don't reach into the daemon itself — instead we recreate the
 * one-line wiring (`app.set('trust proxy', hops)`) and inject a fake
 * `X-Forwarded-For` header to confirm the resulting `req.ip`.
 */

import http from 'node:http';
import type { Request, Response } from 'express';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

interface Harness {
  port: number;
  close: () => Promise<void>;
}

async function startApp(trustProxyHops: number, capture: (req: Request) => void): Promise<Harness> {
  const app = express();
  app.set('trust proxy', trustProxyHops);
  app.get('/', (req: Request, res: Response) => {
    capture(req);
    res.status(204).end();
  });
  return await new Promise<Harness>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no addr'));
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((r, rj) => {
            server.close((err) => (err ? rj(err) : r()));
          }),
      });
    });
  });
}

function get(port: number, headers: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      }
    );
    req.on('error', reject);
    req.end();
  });
}

let harness: Harness | undefined;

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = undefined;
  }
});

describe('trust proxy wiring', () => {
  it('ignores X-Forwarded-For when trust_proxy_hops = 0', async () => {
    let captured: Request | undefined;
    harness = await startApp(0, (req) => {
      captured = req;
    });
    await get(harness.port, { 'x-forwarded-for': '8.8.8.8, 9.9.9.9' });
    // With trust proxy off, req.ip is the actual socket peer (loopback),
    // NOT the spoofed value in X-Forwarded-For.
    expect(captured?.ip).toMatch(/127\.0\.0\.1|::ffff:127\.0\.0\.1|::1/);
  });

  it('honours X-Forwarded-For when trust_proxy_hops > 0', async () => {
    let captured: Request | undefined;
    harness = await startApp(1, (req) => {
      captured = req;
    });
    await get(harness.port, { 'x-forwarded-for': '8.8.8.8' });
    // With one trusted hop, the rightmost forwarded entry becomes req.ip.
    expect(captured?.ip).toBe('8.8.8.8');
  });
});
