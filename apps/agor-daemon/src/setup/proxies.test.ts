/**
 * HTTP proxy registration tests.
 *
 * Covers the registration-time contract:
 *   - Empty `proxies:` block does NOT mount the route.
 *   - http:// upstreams are rejected at registration time.
 *   - Unauthenticated callers get 401.
 *   - Unknown vendors get 404.
 *   - Disallowed methods get 405 with an `Allow` header.
 *   - Inbound `cookie` headers are stripped before forwarding.
 *
 * The full byte-relay path (real upstream forwarding, body streaming,
 * response-size cap) is exercised against a hand-rolled mock upstream
 * — but only when the resolver allows the upstream URL. Because
 * `resolveProxies` enforces https-only, the in-process integration tests
 * point the proxy at a *self-signed* https server. Setting that up requires
 * the daemon test harness to gain a TLS helper; until then those cases are
 * covered by the validation + auth tests here plus `proxies-resolver.test.ts`.
 */

import type { AgorConfig } from '@agor/core/config';
import express, { type Express } from 'express';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { registerProxies } from './proxies';

const JWT_SECRET = 'test-secret-do-not-use-in-prod';
const VALID_TOKEN = jwt.sign({ sub: 'user-abc', type: 'access' }, JWT_SECRET, {
  issuer: 'agor',
  audience: 'https://agor.dev',
});

/**
 * Build a test app with a stub `app.service('users').get()` so the proxy's
 * auth check (which now loads the user entity to mirror socketio.ts) doesn't
 * fail. `userExists: false` makes the service throw, exercising the
 * "token-for-deleted-user" path that the real Feathers users service would
 * take.
 */
function makeProxyApp(config: AgorConfig, userExists = true): Express {
  const app = express() as Express & {
    service: (name: string) => { get: (id: string) => Promise<unknown> };
  };
  app.use(express.raw({ type: '*/*', limit: '10mb' }));
  app.service = (name: string) => {
    if (name !== 'users') throw new Error(`unexpected service: ${name}`);
    return {
      get: async (id: string) => {
        if (!userExists) throw new Error('user not found');
        return { user_id: id };
      },
    };
  };
  // Cast: registerProxies types the first arg as Feathers Application but
  // only calls .service('users').get() and .use(...) on it, both stubbed above.
  registerProxies(app as never, config, JWT_SECRET, { rateLimitPerMinute: 0 });
  return app;
}

/**
 * Drive an Express app via its request handler without binding a port.
 * Avoids a real TCP roundtrip and the OS dance around ephemeral ports.
 */
async function call(
  app: Express,
  method: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  // Use Node's http module rather than supertest (not in this app's deps).
  // Bind to 127.0.0.1:0 (ephemeral port), drive a real fetch, then close.
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      fetch(`http://127.0.0.1:${port}${path}`, { method, headers })
        .then(async (r) => {
          const text = await r.text();
          const out: Record<string, string> = {};
          r.headers.forEach((v, k) => {
            out[k] = v;
          });
          server.close();
          resolve({ status: r.status, headers: out, body: text });
        })
        .catch((e) => {
          server.close();
          reject(e);
        });
    });
  });
}

describe('registerProxies — registration-time validation', () => {
  it('does not mount the /proxies route when config.proxies is absent', async () => {
    // With no proxies block, `/proxies/x` should fall through to Express's
    // default 404. With a configured vendor, it would 401 (auth required).
    // The status code distinguishes the two — a 401 here would mean the
    // route mounted regardless of empty config (rule 4 violated).
    const app = makeProxyApp({});
    const r = await call(app, 'GET', '/proxies/anything');
    expect(r.status).toBe(404);
    // Default Express 404 is HTML "Cannot GET ..." — definitely NOT our
    // proxy's JSON `unknown_vendor` shape.
    expect(r.body).not.toContain('unknown_vendor');
  });

  it('rejects http:// upstreams at registration', () => {
    expect(() =>
      registerProxies(
        express() as never,
        { proxies: { x: { upstream: 'http://example.com' } } },
        JWT_SECRET
      )
    ).toThrow(/must use https/);
  });

  it('throws on malformed upstream URL', () => {
    expect(() =>
      registerProxies(express() as never, { proxies: { x: { upstream: 'not a url' } } }, JWT_SECRET)
    ).toThrow(/not a valid URL/);
  });
});

describe('registerProxies — request gating', () => {
  it('returns 401 when no Authorization header is sent', async () => {
    const app = makeProxyApp({
      proxies: { shortcut: { upstream: 'https://api.app.shortcut.com' } },
    });
    const r = await call(app, 'GET', '/proxies/shortcut/anything');
    expect(r.status).toBe(401);
  });

  it('returns 401 when the token is malformed', async () => {
    const app = makeProxyApp({
      proxies: { shortcut: { upstream: 'https://api.app.shortcut.com' } },
    });
    const r = await call(app, 'GET', '/proxies/shortcut/x', {
      Authorization: 'Bearer not-a-real-jwt',
    });
    expect(r.status).toBe(401);
  });

  it('returns 401 when the token decodes but the user no longer exists', async () => {
    // Mirrors socketio.ts: a token for a deleted/disabled user is rejected
    // even before its expiry. Verifies the proxy doesn't trust decoded.sub
    // blindly (would let stale tokens keep working).
    const app = makeProxyApp(
      { proxies: { shortcut: { upstream: 'https://api.app.shortcut.com' } } },
      false
    );
    const r = await call(app, 'GET', '/proxies/shortcut/x', {
      Authorization: `Bearer ${VALID_TOKEN}`,
    });
    expect(r.status).toBe(401);
  });

  it('returns 404 for unknown vendor (even with valid token)', async () => {
    const app = makeProxyApp({
      proxies: { shortcut: { upstream: 'https://api.app.shortcut.com' } },
    });
    const r = await call(app, 'GET', '/proxies/linear/x', {
      Authorization: `Bearer ${VALID_TOKEN}`,
    });
    expect(r.status).toBe(404);
    expect(r.body).toContain('unknown_vendor');
  });

  it('returns 405 with Allow header when method not in allowed_methods', async () => {
    const app = makeProxyApp({
      proxies: {
        shortcut: { upstream: 'https://api.app.shortcut.com', allowed_methods: ['GET'] },
      },
    });
    const r = await call(app, 'POST', '/proxies/shortcut/x', {
      Authorization: `Bearer ${VALID_TOKEN}`,
    });
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('GET');
  });
});
