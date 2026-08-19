/**
 * The CLI talks to the daemon over REST while the UI talks over Socket.IO, so the
 * REST transport is only ever exercised by the CLI. That asymmetry hid a bug: the
 * Feathers authentication hook decorates the standard service methods but not
 * custom methods registered via `service.methods(...)`, so `agor board export`,
 * `clone` and `import` all went out unauthenticated and the daemon answered 401.
 *
 * These tests pin the header onto the transport itself, against a real HTTP server,
 * so a future refactor of the auth wiring cannot quietly drop it again.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRestClient } from './index';

interface CapturedRequest {
  method: string;
  url: string;
  serviceMethod: string | undefined;
  authorization: string | undefined;
}

const ACCESS_TOKEN = 'header.payload.signature';

describe('createRestClient authorization', () => {
  let server: Server;
  let baseUrl: string;
  let captured: CapturedRequest[];

  beforeEach(async () => {
    captured = [];
    server = createServer((req, res) => {
      const serviceMethod = req.headers['x-service-method'];
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        serviceMethod: Array.isArray(serviceMethod) ? serviceMethod[0] : serviceMethod,
        authorization: req.headers.authorization,
      });

      // Drain the request body so 'end' fires; the contents are not asserted on.
      req.on('data', () => {});
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url?.startsWith('/authentication')) {
          res.end(
            JSON.stringify({
              accessToken: ACCESS_TOKEN,
              user: { user_id: 'u1', email: 'someone@example.com' },
            })
          );
          return;
        }
        if (serviceMethod === 'toYaml') {
          res.end(JSON.stringify('name: Main Board\n'));
          return;
        }
        res.end(JSON.stringify({ total: 0, limit: 10, skip: 0, data: [] }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('sends the bearer token on custom methods, not just standard ones', async () => {
    const client = await createRestClient(baseUrl);
    await client.authenticate({ strategy: 'jwt', accessToken: ACCESS_TOKEN });

    await client.service('boards').find({});
    await (
      client.service('boards') as unknown as { toYaml: (data: unknown) => Promise<string> }
    ).toYaml({ id: 'board-1' });

    const find = captured.find(
      (entry) => entry.method === 'GET' && entry.url.startsWith('/boards')
    );
    const custom = captured.find((entry) => entry.serviceMethod === 'toYaml');

    expect(find?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    // The regression: this one used to arrive with no Authorization header at all.
    expect(custom?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('does not attach a stale bearer to the login exchange itself', async () => {
    const client = await createRestClient(baseUrl);
    await client.authenticate({ strategy: 'jwt', accessToken: ACCESS_TOKEN });
    // A second login is how the CLI replaces an expired credential; sending the old
    // token would 401 the very call meant to replace it.
    await client.authenticate({ strategy: 'jwt', accessToken: ACCESS_TOKEN });

    const authRequests = captured.filter((entry) => entry.url.startsWith('/authentication'));
    expect(authRequests.length).toBeGreaterThanOrEqual(2);
    for (const request of authRequests) {
      expect(request.authorization).toBeUndefined();
    }
  });

  it('uses an explicit API key for every call, including custom methods', async () => {
    const client = await createRestClient(baseUrl, 'api-key-value');

    await client.service('boards').find({});
    await (
      client.service('boards') as unknown as { toYaml: (data: unknown) => Promise<string> }
    ).toYaml({ id: 'board-1' });

    expect(captured).not.toHaveLength(0);
    for (const request of captured) {
      expect(request.authorization).toBe('Bearer api-key-value');
    }
  });

  it('sends no bearer before anything has authenticated', async () => {
    const client = await createRestClient(baseUrl);
    await client.service('boards').find({});

    expect(captured.at(-1)?.authorization).toBeUndefined();
  });
});
