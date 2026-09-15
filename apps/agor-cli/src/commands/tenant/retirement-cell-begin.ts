import { loadConfig } from '@agor/core/config';
import { createDatabase, getDatabaseUrl } from '@agor/core/db';
import { Command, Flags } from '@oclif/core';
import {
  beginManagedCellRetirement,
  validateManagedCellRetirementRequest,
} from '../../lib/managed-oauth-retirement.js';
import {
  EXIT_FAILURE,
  EXIT_INVALID_INPUT,
  flushStderr,
  formatPortabilityError,
  writeStdoutJson,
} from '../../lib/tenant-portability.js';

export default class TenantRetirementCellBegin extends Command {
  static override summary =
    'Permanently stop managed OAuth vending in this cell before decommission';
  static override description =
    'Irreversible DB-local barrier, not a pause. Only for whole-cell decommission, never workspace rehome, ordinary backup, sleep or drain. Repeating the same operation is idempotent; a different operation is refused.';
  static override flags = {
    'cell-id': Flags.string({
      required: true,
      description: 'Must equal the local configured cell ID',
    }),
    'operation-id': Flags.string({
      required: true,
      description: 'Stable decommission operation ID',
    }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(TenantRetirementCellBegin);
    const input = { cell_id: flags['cell-id'], operation_id: flags['operation-id'] };
    let configuredCellId: string | undefined;
    try {
      configuredCellId = (await loadConfig()).managed_mcp_oauth?.cell_id;
      validateManagedCellRetirementRequest(input, configuredCellId);
    } catch (error) {
      this.logToStderr(formatPortabilityError(error));
      await flushStderr();
      process.exit(EXIT_INVALID_INPUT);
    }
    try {
      const result = await beginManagedCellRetirement(
        createDatabase({ url: getDatabaseUrl() }),
        input,
        configuredCellId
      );
      await writeStdoutJson(result);
      await flushStderr();
      process.exit(0);
    } catch (error) {
      this.logToStderr(formatPortabilityError(error));
      await flushStderr();
      process.exit(EXIT_FAILURE);
    }
  }
}
