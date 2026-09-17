/** Operator-only catalog measurement. No tenant inventory or admission assertion. */
import {
  type Database,
  readManagedOAuthDatabaseObservation,
  runWithSystemDatabaseScope,
} from '@agor/core/db';
import {
  type MCPManagedOAuthDatabaseObservationReport,
  MCPManagedOAuthDatabaseObservationReportSchema,
  McpOAuthIdSchema,
} from '@agor/core/types';

export function validateManagedObservationCell(cellId: string, configuredCellId?: string): void {
  if (
    !McpOAuthIdSchema.safeParse(cellId).success ||
    !configuredCellId ||
    cellId !== configuredCellId
  )
    throw new Error('Managed observation requires the configured cell identifier');
}

export async function observeManagedOAuthDatabase(
  db: Database,
  cellId: string,
  configuredCellId?: string
): Promise<MCPManagedOAuthDatabaseObservationReport> {
  validateManagedObservationCell(cellId, configuredCellId);
  // Deliberate system metadata read, not a tenant scope escalation or maintenance capability.
  const observation = await runWithSystemDatabaseScope(db, 'managed database observation', (tx) =>
    readManagedOAuthDatabaseObservation(tx)
  );
  return MCPManagedOAuthDatabaseObservationReportSchema.parse({ ...observation, cell_id: cellId });
}
