import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMCPOAuthCallbackRoute } from './mcp-oauth-callback-route.js';

describe('createMCPOAuthCallbackRoute', () => {
  const servers: Array<ReturnType<ReturnType<typeof express>['listen']>> = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve()))
            )
        )
    );
  });

  async function listen(app: ReturnType<typeof express>): Promise<string> {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');
    return `http://127.0.0.1:${address.port}`;
  }

  it('delivers the exact browser callback to the installed handler', async () => {
    const route = createMCPOAuthCallbackRoute();
    const handler = vi.fn((_req, res) => res.status(200).send('connected'));
    route.setHandler(handler);
    const app = express();
    app.use('/mcp-servers/oauth-callback', route.middleware);
    const origin = await listen(app);

    const response = await fetch(
      `${origin}/mcp-servers/oauth-callback?code=secret-code&state=secret-state`
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('connected');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('returns 503 rather than a misleading 404 while service wiring is unavailable', async () => {
    const route = createMCPOAuthCallbackRoute();
    const app = express();
    app.use('/mcp-servers/oauth-callback', route.middleware);
    const origin = await listen(app);

    const response = await fetch(`${origin}/mcp-servers/oauth-callback?code=x&state=y`);

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('does not claim callback subpaths', async () => {
    const route = createMCPOAuthCallbackRoute();
    route.setHandler(vi.fn());
    const app = express();
    app.use('/mcp-servers/oauth-callback', route.middleware);
    app.use((_req, res) => res.status(404).send('not found'));
    const origin = await listen(app);

    const response = await fetch(`${origin}/mcp-servers/oauth-callback/unrelated`);

    expect(response.status).toBe(404);
  });
});
