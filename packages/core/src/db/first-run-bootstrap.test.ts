import { describe, expect } from 'vitest';
import { select } from './database-wrapper';
import { bootstrapFirstRunAdmin } from './first-run-bootstrap';
import { seedInitialData } from './migrate';
import { boards } from './schema';
import { dbTest } from './test-helpers';
import { createUser } from './user-utils';

describe('bootstrapFirstRunAdmin', () => {
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
    await seedInitialData(db);

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
