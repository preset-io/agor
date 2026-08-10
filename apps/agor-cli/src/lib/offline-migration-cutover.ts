import {
  type Database,
  OfflineMigrationCutoverRequiredError,
  pendingOfflineCutoverMigrations,
  runMigrations,
} from '@agor/core/db';

interface MigrationStatus {
  pending: readonly string[];
  applied: readonly string[];
}

export function requireOfflineCutoverAcknowledgement(
  status: MigrationStatus,
  acknowledged: boolean
): void {
  const offlineMigrations = pendingOfflineCutoverMigrations(status);
  if (offlineMigrations.length > 0 && !acknowledged) {
    throw new OfflineMigrationCutoverRequiredError(offlineMigrations);
  }
}

/** Testable CLI boundary that must propagate the explicit operator acknowledgement. */
export async function runConfirmedMigrations(
  db: Database,
  offlineCutover: boolean,
  migrate: typeof runMigrations = runMigrations
): Promise<void> {
  await migrate(db, { allowOfflineCutover: offlineCutover });
}
