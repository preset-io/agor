import { describe, expect, it, vi } from 'vitest';
import {
  requireOfflineCutoverAcknowledgement,
  runConfirmedMigrations,
} from './offline-migration-cutover.js';

const existingDatabaseStatus = {
  applied: ['0073_task_runtime_reconciliation'],
  pending: ['0074_knowledge_embedding_claims'],
};

describe('offline migration cutover CLI boundary', () => {
  it('refuses an existing-database cutover without the dedicated acknowledgement', () => {
    expect(() => requireOfflineCutoverAcknowledgement(existingDatabaseStatus, false)).toThrow(
      'Offline migration cutover required'
    );
  });

  it('accepts the dedicated acknowledgement and propagates it to the migration runner', async () => {
    requireOfflineCutoverAcknowledgement(existingDatabaseStatus, true);
    const migrate = vi.fn(async () => undefined);
    const db = { dialect: 'postgresql' } as never;

    await runConfirmedMigrations(db, true, migrate);

    expect(migrate).toHaveBeenCalledWith(db, { allowOfflineCutover: true });
  });
});
