/**
 * `agor tenant gate release` — lift a tenant's write freeze. Removes the gate
 * only when the live generation matches the one the caller holds (compare-and-
 * delete), unless --force. An absent gate is an idempotent no-op success. A
 * single stable JSON object is written to stdout; audit lines go to stderr.
 */

import {
  assertValidTenantId,
  createDatabase,
  getDatabaseUrl,
  InvalidTenantIdError,
  releaseTenantWriteGate,
  TenantWriteGateGenerationError,
  TenantWriteGateUnsupportedError,
} from '@agor/core/db';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  EXIT_FAILURE,
  EXIT_INVALID_INPUT,
  flushStderr,
  formatPortabilityError,
  writeStdoutJson,
} from '../../../lib/tenant-portability.js';

/** Exit code when the held generation does not match the live gate. */
const EXIT_GENERATION_MISMATCH = 3;

export default class TenantGateRelease extends Command {
  static override description =
    "Release a tenant's write gate for the generation the caller holds (compare-and-delete). " +
    'Refuses on a generation mismatch unless --force; an absent gate is an idempotent no-op. PostgreSQL-only.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp --generation <gen>',
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp --generation <gen> --force',
  ];

  static override flags = {
    'tenant-id': Flags.string({ description: 'Tenant id to unfreeze', required: true }),
    generation: Flags.string({
      description: 'The generation the caller holds; the gate is removed only if it matches',
      required: true,
    }),
    force: Flags.boolean({
      description: 'Remove the gate even if the generation differs',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(TenantGateRelease);
    const tenantId = flags['tenant-id'];

    try {
      assertValidTenantId(tenantId);
    } catch (error) {
      if (error instanceof InvalidTenantIdError) {
        this.logToStderr(formatPortabilityError(error));
        await flushStderr();
        process.exit(EXIT_INVALID_INPUT);
      }
      throw error;
    }

    try {
      const db = createDatabase({ url: getDatabaseUrl() });
      const result = await releaseTenantWriteGate(db, tenantId, {
        generation: flags.generation,
        force: flags.force,
      });
      await writeStdoutJson({ tenantId, ...result });
      this.logToStderr(
        chalk.green(
          `✓ Write gate for ${chalk.cyan(tenantId)} ${result.released ? `released (${result.reason})` : 'was not active'}`
        )
      );
      await flushStderr();
      process.exit(0);
    } catch (error) {
      this.logToStderr(formatPortabilityError(error));
      if (error instanceof TenantWriteGateGenerationError) {
        this.logToStderr(
          chalk.dim('  The live generation does not match; use --force to override.')
        );
        await flushStderr();
        process.exit(EXIT_GENERATION_MISMATCH);
      }
      if (error instanceof TenantWriteGateUnsupportedError) {
        this.logToStderr(
          chalk.dim(
            '  Point the command at a PostgreSQL database (AGOR_DB_DIALECT=postgresql, DATABASE_URL=…).'
          )
        );
      }
      await flushStderr();
      process.exit(EXIT_FAILURE);
    }
  }
}
