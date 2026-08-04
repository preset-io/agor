/**
 * `agor tenant gate acquire` — freeze a tenant's writes and return a
 * generation-bound proof. An external orchestrator acquires the gate before an
 * export/migrate/delete, confirms it stayed continuously held (see
 * `tenant gate inspect --expect-generation`), and releases it afterward. A single
 * stable JSON object is written to stdout; audit lines go to stderr.
 */

import {
  acquireTenantWriteGate,
  assertValidTenantId,
  createDatabase,
  getDatabaseUrl,
  InvalidTenantIdError,
  TenantWriteGateHeldError,
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

/** Exit code when the gate is already held (without --force). */
const EXIT_ALREADY_HELD = 3;

export default class TenantGateAcquire extends Command {
  static override description =
    "Acquire the per-tenant write gate, freezing the tenant's writes and returning a generation-bound " +
    'proof. Refuses if a gate is already held unless --force replaces it (minting a new generation). ' +
    'PostgreSQL-only.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp --reason offboarding',
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp --force',
  ];

  static override flags = {
    'tenant-id': Flags.string({ description: 'Tenant id to freeze', required: true }),
    holder: Flags.string({ description: 'Label identifying the operator acquiring the gate' }),
    reason: Flags.string({ description: 'Reason recorded for audit' }),
    force: Flags.boolean({
      description: 'Replace an existing gate (mints a new generation)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(TenantGateAcquire);
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
      const result = await acquireTenantWriteGate(db, tenantId, {
        ...(flags.holder ? { holder: flags.holder } : {}),
        ...(flags.reason ? { reason: flags.reason } : {}),
        force: flags.force,
      });
      await writeStdoutJson({ tenantId, ...result });
      this.logToStderr(
        chalk.green(
          `✓ Write gate acquired for ${chalk.cyan(tenantId)} — generation ${chalk.cyan(result.generation)}`
        )
      );
      await flushStderr();
      process.exit(0);
    } catch (error) {
      this.logToStderr(formatPortabilityError(error));
      if (error instanceof TenantWriteGateHeldError) {
        this.logToStderr(
          chalk.dim('  A gate is already held; use --force to replace it with a new generation.')
        );
        await flushStderr();
        process.exit(EXIT_ALREADY_HELD);
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
