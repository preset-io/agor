import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { deleteFrom, select, update } from './database-wrapper';
import { bootstrapFirstRunAdmin } from './first-run-bootstrap';
import { seedInitialData } from './migrate';
import { boards, users } from './schema';
import { dbTest } from './test-helpers';
import { createUser } from './user-utils';

describe('bootstrapFirstRunAdmin', () => {
  dbTest('allows competing daemon seeders to converge on one default board', async ({ db }) => {
    await Promise.all([seedInitialData(db, 'test-user'), seedInitialData(db, 'test-user')]);

    const boardRows = await select(db).from(boards).all();
    expect(boardRows).toHaveLength(1);
    expect(boardRows[0].slug).toBe('default');
  });

  dbTest('allows competing daemon admin bootstraps to converge on one user', async ({ db }) => {
    await deleteFrom(db, users).where(eq(users.user_id, 'test-user')).run();
    const createAdmin = () =>
      createUser(db, {
        email: 'admin@agor.live',
        password: 'concurrent-bootstrap-password',
        role: 'superadmin',
      });

    const results = await Promise.all([
      bootstrapFirstRunAdmin(db, createAdmin),
      bootstrapFirstRunAdmin(db, createAdmin),
    ]);

    expect(results.filter((result) => result.createdAdmin)).toHaveLength(1);
    expect(new Set(results.map((result) => result.admin?.user_id)).size).toBe(1);
  });

  dbTest('prefers existing superadmins when reattributing legacy rows', async ({ db }) => {
    const member = await createUser(db, {
      email: 'member@example.com',
      password: 'member-password',
      role: 'member',
    });
    const superadmin = await createUser(db, {
      email: 'superadmin@example.com',
      password: 'superadmin-password',
      role: 'superadmin',
    });
    await seedInitialData(db, superadmin.user_id);
    await update(db, boards)
      .set({ created_by: 'anonymous' })
      .where(eq(boards.slug, 'default'))
      .run();

    const result = await bootstrapFirstRunAdmin(db, async () => {
      throw new Error('should not create an admin when users already exist');
    });

    expect(result.createdAdmin).toBe(false);
    expect(result.admin?.user_id).toBe(superadmin.user_id);
    expect(result.admin?.user_id).not.toBe(member.user_id);
    expect(result.reattributedCount).toBe(1);

    const boardRows = await select(db).from(boards).all();
    expect(boardRows).toHaveLength(1);
    expect(boardRows[0].created_by).toBe(superadmin.user_id);
  });
});
