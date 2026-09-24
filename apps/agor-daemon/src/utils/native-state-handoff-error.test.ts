import type { Server } from 'node:http';
import { OpenCodeNativeStateHandoffRequiredError } from '@agor/core/db';
import { errorHandler, feathers, feathersExpress, rest } from '@agor/core/feathers';
import { describe, expect, it } from 'vitest';
import { mapNativeStateHandoffError } from './native-state-handoff-error';

describe('native-state handoff API error boundary', () => {
  it('returns a typed nonretryable conflict instead of a generic 500', async () => {
    const app = feathersExpress(feathers());
    app.configure(rest());
    app.use('/sessions', {
      async remove() {
        throw new OpenCodeNativeStateHandoffRequiredError('session');
      },
    });
    app.hooks({ error: { all: [mapNativeStateHandoffError] } });
    app.use(errorHandler());

    const server = (await app.listen(0)) as Server;
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
      const response = await fetch(`http://127.0.0.1:${address.port}/sessions/known`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        data: { code: 'native_state_handoff_required', retryable: false },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
