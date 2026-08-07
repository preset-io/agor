import type { Server } from 'node:http';
import { feathers, feathersExpress } from '@agor/core/feathers';
import { afterEach, describe, expect, it } from 'vitest';
import { configureSwagger } from './swagger.js';

describe('OpenAPI routes', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  async function origin(): Promise<string> {
    const app = feathersExpress(feathers());
    configureSwagger(app, { version: '1.2.3', port: 3030 });
    app.use('examples', {
      async find() {
        return [];
      },
    });
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
    return `http://127.0.0.1:${address.port}`;
  }

  it('serves the machine-readable schema without a bundled documentation UI', async () => {
    const response = await fetch(`${await origin()}/docs.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      paths: Record<string, Record<string, { summary?: string }>>;
    };
    expect(document).toMatchObject({
      openapi: '3.0.3',
      info: { title: 'Agor API', version: '1.2.3' },
    });
    expect(document.paths['/examples']?.get?.summary).toBe(
      'Retrieves a list of all resources from the service'
    );
  });

  it.each(['/docs', '/docs/'])('redirects %s to the maintained reference', async (path) => {
    const response = await fetch(`${await origin()}${path}`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://agor.live/api-reference');
  });
});
