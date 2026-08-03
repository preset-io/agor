/**
 * `agor tenant delete` - Permanently delete all data for a single tenant.
 *
 * Operators of a standalone multi-tenant PostgreSQL runtime use this to remove
 * a tenant entirely (offboarding, data-removal requests, regulatory erasure).
 * It runs non-interactively (container/Job friendly), uses the runtime database
 * configuration, and prints a single stable JSON object to stdout for external
 * automation. Human audit logging goes to stderr so stdout stays parseable.
 */

import { createDatabase, getDatabaseUrl } from '@agor/core/db';
import {
  assertValidTenantId,
  deleteTenant,
  InvalidTenantIdError,
  TenantDeletionUnsupportedError,
  TenantDeletionVerificationError,
  TenantFilesystemDeletionPendingError,
} from '@agor/core/tenant-portability';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  EXIT_FAILURE,
  EXIT_INVALID_INPUT,
  flushStderr,
  formatPortabilityError,
  resolveTenantFilesystem,
  writeStdoutJson,
} from '../../lib/tenant-portability.js';

/** Named export retained for focused CLI contract coverage. */
export const tenantDeleteErrorMarker = formatPortabilityError;

export default class TenantDelete extends Command {
  static override description =
    'Permanently delete all data belonging to a single tenant in a standalone multi-tenant PostgreSQL runtime. Idempotent and verified. ' +
    'Preconditions: quiesce tenant writes and schema changes for the entire operation, and ensure every foreign-key reference between tenant rows is tenant-consistent. ' +
    'PostgreSQL row-level security neither enforces tenant equality when foreign keys are created nor constrains referential actions such as cascades. ' +
    'This command cannot prevent a writer or schema change that occurs after final verification.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp',
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp --dry-run',
  ];

  static override flags = {
    'tenant-id': Flags.string({
      description: 'Tenant id whose data will be permanently deleted',
      required: true,
    }),
    'dry-run': Flags.boolean({
      char: 'n',
      description: 'Report the row counts that would be deleted without deleting anything',
      default: false,
    }),
    'database-only': Flags.boolean({
      description: 'Delete only the database rows, leaving the tenant filesystem tree in place',
      default: false,
    }),
    'assert-gate-generation': Flags.string({
      description:
        'Require the tenant write gate to be held at this generation inside the deletion transaction; abort if lost or replaced',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(TenantDelete);
    const tenantId = flags['tenant-id'];
    const dryRun = flags['dry-run'];

    // Validate before touching the database so bad input never opens a connection.
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
      this.logToStderr(
        chalk.bold(
          `${dryRun ? '🔎 Dry run:' : '⚠️  Deleting'} all data for tenant ${chalk.cyan(tenantId)}`
        )
      );

      const filesystem = flags['database-only'] ? null : await resolveTenantFilesystem(tenantId);
      if (!flags['database-only'] && !filesystem) {
        this.logToStderr(
          chalk.dim('  Filesystem isolation is disabled; leaving the shared data home untouched.')
        );
      }

      const db = createDatabase({ url: getDatabaseUrl() });
      const result = await deleteTenant(db, tenantId, {
        dryRun,
        databaseOnly: flags['database-only'],
        filesystem,
        log: (message) => this.logToStderr(chalk.dim(`  ${message}`)),
        ...(flags['assert-gate-generation']
          ? { assertGateGeneration: flags['assert-gate-generation'] }
          : {}),
      });

      // Stable combined database + filesystem proof on stdout. Await the write
      // before process.exit so a piped caller always receives the full object.
      await writeStdoutJson(result);

      if (result.filesystem.status === 'deleted') {
        this.logToStderr(chalk.dim('  deleted tenant filesystem tree'));
      }

      const totalRows = Object.values(result.rowCounts).reduce((sum, value) => sum + value, 0);
      this.logToStderr(
        chalk.green(
          `✓ ${dryRun ? 'Dry run complete' : 'Tenant data deleted and verified'} — ${totalRows} row(s)`
        )
      );
      await flushStderr();
      process.exit(0);
    } catch (error) {
      const marker = tenantDeleteErrorMarker(error);
      if (error instanceof TenantFilesystemDeletionPendingError) {
        // The database is already committed. Emit bounded recovery state even
        // though the command exits non-zero, so automation can distinguish this
        // retryable DB-done/files-pending tail from a pre-commit failure.
        await writeStdoutJson(error.result);
      }
      this.logToStderr(marker);
      if (error instanceof TenantDeletionVerificationError) {
        this.logToStderr(chalk.red('  Deletion verification did not prove tenant absence.'));
      }
      if (error instanceof TenantDeletionUnsupportedError) {
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
