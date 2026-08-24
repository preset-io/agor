import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { createUsersService } from './users.js';

describe('UsersService not-found contract', () => {
  dbTest('uses the Feathers 404 contract for public and authentication lookups', async ({ db }) => {
    const service = createUsersService(db);

    await expect(service.get('missing-user' as never)).rejects.toMatchObject({
      code: 404,
      className: 'not-found',
    });
    await expect(service.getWithPassword('missing-user' as never)).rejects.toMatchObject({
      code: 404,
      className: 'not-found',
    });
  });
});
