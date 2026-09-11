import { dbTest } from '../test-helpers';
import { exerciseCapabilityPredicateParity } from './branch-access.parity-test-helpers';

dbTest(
  'SQL capability predicates match point resolution for every role and filesystem dimension (SQLite)',
  async ({ db }) => {
    await exerciseCapabilityPredicateParity(db);
  },
  30000
);
