import { loadConfig } from '@agor/core/config';
import { createDatabase, getDatabaseUrl } from '@agor/core/db';
import { Command, Flags } from '@oclif/core';
import {
  observeManagedOAuthDatabase,
  validateManagedObservationCell,
} from '../../lib/managed-oauth-observation.js';
import {
  EXIT_FAILURE,
  EXIT_INVALID_INPUT,
  flushStderr,
  writeStdoutJson,
} from '../../lib/tenant-portability.js';

export default class ManagedOAuthObserveDatabase extends Command {
  static override summary = 'Read managed OAuth schema and actual database-role evidence';
  static override description =
    'Read-only PostgreSQL catalog/ledger measurement for a trusted deployment observer. No migrations, tenant records, tokens or provider I/O. This is not a signed cohort, inventory fence or deployment eligibility assertion.';
  static override flags = {
    'cell-id': Flags.string({
      required: true,
      description: 'Must equal the local configured cell ID',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ManagedOAuthObserveDatabase);
    let configuredCellId: string | undefined;
    try {
      configuredCellId = (await loadConfig()).managed_mcp_oauth?.cell_id;
      validateManagedObservationCell(flags['cell-id'], configuredCellId);
    } catch {
      this.logToStderr('Managed database observation configuration is invalid');
      await flushStderr();
      process.exit(EXIT_INVALID_INPUT);
    }
    try {
      const report = await observeManagedOAuthDatabase(
        createDatabase({ url: getDatabaseUrl() }),
        flags['cell-id'],
        configuredCellId
      );
      await writeStdoutJson(report);
      await flushStderr();
      process.exit(0);
    } catch {
      this.logToStderr('Managed database observation is unavailable');
      await flushStderr();
      process.exit(EXIT_FAILURE);
    }
  }
}
