import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { UsersService } from './users';

describe('UsersService.find', () => {
  dbTest('respects limit/skip pagination and reports total matches', async ({ db }) => {
    const service = new UsersService(db);

    await service.create({ email: 'alpha@example.com', password: 'password-123', name: 'Alpha' });
    await service.create({ email: 'bravo@example.com', password: 'password-123', name: 'Bravo' });
    await service.create({
      email: 'charlie@example.com',
      password: 'password-123',
      name: 'Charlie',
    });

    const page = await service.find({ query: { $limit: 1, $skip: 1 } });

    expect(page.total).toBe(3);
    expect(page.limit).toBe(1);
    expect(page.skip).toBe(1);
    expect(page.data).toHaveLength(1);
    expect(page.data[0].email).toBe('bravo@example.com');
  });

  dbTest('supports offset alias for pagination', async ({ db }) => {
    const service = new UsersService(db);

    await service.create({ email: 'alpha@example.com', password: 'password-123', name: 'Alpha' });
    await service.create({ email: 'bravo@example.com', password: 'password-123', name: 'Bravo' });

    const page = await service.find({ query: { limit: 1, offset: 1 } });

    expect(page.total).toBe(2);
    expect(page.limit).toBe(1);
    expect(page.skip).toBe(1);
    expect(page.data.map((user) => user.email)).toEqual(['bravo@example.com']);
  });

  dbTest(
    'searches name/email/unix_username case-insensitively before pagination',
    async ({ db }) => {
      const service = new UsersService(db);

      await service.create({
        email: 'reed@preset.io',
        password: 'password-123',
        name: 'Reed Thompson',
        unix_username: 'rthompson',
      });
      await service.create({
        email: 'someone@example.com',
        password: 'password-123',
        name: 'Someone Else',
        unix_username: 'someone',
      });

      const byName = await service.find({ query: { search: 'REED', $limit: 10 } });
      expect(byName.total).toBe(1);
      expect(byName.data[0].email).toBe('reed@preset.io');

      const byEmail = await service.find({ query: { q: 'PRESET.IO', $limit: 10 } });
      expect(byEmail.total).toBe(1);
      expect(byEmail.data[0].name).toBe('Reed Thompson');

      const byUnix = await service.find({ query: { query: 'THOMP', $limit: 10 } });
      expect(byUnix.total).toBe(1);
      expect(byUnix.data[0].unix_username).toBe('rthompson');
    }
  );
});
