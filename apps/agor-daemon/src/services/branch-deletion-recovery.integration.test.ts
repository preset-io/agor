import { ownedDbTest } from '../../../../packages/core/src/db/test-helpers';
import { exerciseDeletionRecovery } from '../../test/branch-deletion-recovery';

ownedDbTest(
  'recovers rollback, lost DB responses and lost settlement through guarded SQLite HTTP boundaries',
  async ({ db }) => {
    await exerciseDeletionRecovery(db, 'sqlite');
  },
  60_000
);
