import { loadConfig } from '@agor/core/config';
import { createDatabase, getDatabaseUrl } from '@agor/core/db';
import type { MCPManagedOAuthCellRetirementFence } from '@agor/core/types';
import { Command, Flags } from '@oclif/core';
import {
  listManagedRetirementTargets,
  validateManagedRetirementTargets,
} from '../../lib/managed-oauth-retirement.js';
import {
  EXIT_FAILURE,
  EXIT_INVALID_INPUT,
  flushStderr,
  formatPortabilityError,
  writeStdoutJson,
} from '../../lib/tenant-portability.js';
export default class TenantRetirementTargets extends Command {
  static override summary =
    'Page all local managed OAuth retirement targets, including orphaned history';
  static override flags = {
    'cell-id': Flags.string({ dependsOn: ['operation-id', 'assert-cell-gate-generation'] }),
    'operation-id': Flags.string({ dependsOn: ['cell-id', 'assert-cell-gate-generation'] }),
    'assert-cell-gate-generation': Flags.string({ dependsOn: ['cell-id', 'operation-id'] }),
    after: Flags.string({ description: 'Exclusive tenant cursor from next_after' }),
    limit: Flags.integer({ default: 100, min: 1, max: 100, description: 'Bounded page size' }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(TenantRetirementTargets);
    let fence: MCPManagedOAuthCellRetirementFence | undefined;
    let configuredCellId: string | undefined;
    try {
      if (flags['cell-id'] !== undefined) {
        fence = {
          cell_id: flags['cell-id'],
          operation_id: flags['operation-id']!,
          gate_generation: flags['assert-cell-gate-generation']!,
        };
        configuredCellId = (await loadConfig()).managed_mcp_oauth?.cell_id;
      }
      validateManagedRetirementTargets(flags.after, flags.limit, fence, configuredCellId);
    } catch (error) {
      this.logToStderr(formatPortabilityError(error));
      await flushStderr();
      process.exit(EXIT_INVALID_INPUT);
    }
    try {
      const result = await listManagedRetirementTargets(
        createDatabase({ url: getDatabaseUrl() }),
        flags.after,
        flags.limit,
        fence,
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
