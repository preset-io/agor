import { dbTest } from '../test-helpers';
import { exerciseUserScopeReads } from './user-scope-reads.test-helpers';

dbTest('user-scope reads compose with branch and board visibility (SQLite)', async ({ db }) => {
  await exerciseUserScopeReads(db);
});
