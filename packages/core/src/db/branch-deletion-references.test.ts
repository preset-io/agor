import {
  exerciseReadMostlyDeletionReferences,
  exerciseWideDeletionReferences,
} from './branch-deletion-references.test-support';
import { createTenantScopedDatabaseProxy, runWithTenantDatabaseScope } from './tenant-scope';
import { dbTest } from './test-helpers';

dbTest(
  'reconciles legitimate 1000/1001-child rows and multiple wide structured arrays without losing references',
  async ({ db }) => {
    const guarded = createTenantScopedDatabaseProxy(db, { requireScope: true });
    await runWithTenantDatabaseScope(guarded, 'default', exerciseWideDeletionReferences);
  },
  60_000
);

dbTest(
  'pages read-mostly through the cursor, rewrites only changed rows and merges a late writer',
  async ({ db }) => {
    const guarded = createTenantScopedDatabaseProxy(db, { requireScope: true });
    await runWithTenantDatabaseScope(guarded, 'default', exerciseReadMostlyDeletionReferences);
  },
  60_000
);
