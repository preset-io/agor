import { dbTest } from '../test-helpers';
import { exerciseSessionInventory } from './sessions.inventory-test-helpers';

dbTest(
  'session inventory preserves policy precedence, filtering, mapping and pages (SQLite)',
  async ({ db }) => {
    await exerciseSessionInventory(db);
  }
);
