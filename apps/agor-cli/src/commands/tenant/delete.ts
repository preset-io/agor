/**
 * `agor tenant delete` - Permanently delete all data for a single tenant.
 *
 * Operators of a standalone multi-tenant PostgreSQL runtime use this to remove
 * a tenant entirely (offboarding, data-removal requests, regulatory erasure).
 * It runs non-interactively (container/Job friendly), uses the runtime database
 * configuration, and prints a single stable JSON object to stdout for external
 * automation. Human audit logging goes to stderr so stdout stays parseable.
 */

import {
  assertValidTenantId,
  createDatabase,
  deleteTenantData,
  deleteTenantFilesystemTree,
  getDatabaseUrl,
  InvalidTenantIdError,
  summarizeTenantFilesystem,
  TenantDeletionUnsupportedError,
  TenantDeletionVerificationError,
} from '@agor/core/db';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { resolveTenantFilesystem } from '../../lib/tenant-portability.js';

/** Exit code for a rejected / invalid `--tenant-id`. */
const EXIT_INVALID_INPUT = 2;
/** Exit code for any failure after input validation. */
const EXIT_FAILURE = 1;

/**
 * Best-effort redaction of connection-string credentials from an error message
 * before it is written to stderr, so an audit log never leaks a DB password.
 */
function redactSecrets(message: string): string {
  return message.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1[redacted]@');
}

/** Convert any thrown value to a secret-safe stderr message. */
export function tenantDeleteErrorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Wait until every stderr write queued so far has completed. */
function flushStderr(): Promise<void> {
  return new Promise((resolve) => {
    process.stderr.write('', () => resolve());
  });
}

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

  /**
   * Delete (or, in dry-run, report) the tenant's configured filesystem tree.
   * Returns a bounded, secret-free outcome describing what was done. When
   * filesystem isolation is disabled, the tenant has no isolated filesystem root
   * and nothing is touched.
   */
  private async handleFilesystem(
    tenantId: string,
    dryRun: boolean,
    databaseOnly: boolean
  ): Promise<{ isolationEnabled: boolean; present: boolean; deleted: boolean }> {
    if (databaseOnly) {
      return { isolationEnabled: false, present: false, deleted: false };
    }
    const resolved = await resolveTenantFilesystem(tenantId);
    if (!resolved) {
      this.logToStderr(
        chalk.dim('  Filesystem isolation is disabled; leaving the shared data home untouched.')
      );
      return { isolationEnabled: false, present: false, deleted: false };
    }
    const inventory = await summarizeTenantFilesystem(resolved.root);
    if (dryRun) {
      if (inventory.present) {
        this.logToStderr(
          chalk.dim(
            `  would delete tenant filesystem tree (${inventory.fileCount} file(s), ${inventory.totalBytes} byte(s))`
          )
        );
      }
      return { isolationEnabled: true, present: inventory.present, deleted: false };
    }
    const { deleted } = await deleteTenantFilesystemTree(resolved.root, resolved.base);
    if (deleted) this.logToStderr(chalk.dim('  deleted tenant filesystem tree'));
    return { isolationEnabled: true, present: inventory.present, deleted };
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(TenantDelete);
    const tenantId = flags['tenant-id'];
    const dryRun = flags['dry-run'];

    // Validate before touching the database so bad input never opens a connection.
    try {
      assertValidTenantId(tenantId);
    } catch (error) {
      if (error instanceof InvalidTenantIdError) {
        this.logToStderr(chalk.red(`✗ ${error.message}`));
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

      const db = createDatabase({ url: getDatabaseUrl() });
      const result = await deleteTenantData(db, tenantId, {
        dryRun,
        log: (message) => this.logToStderr(chalk.dim(`  ${message}`)),
        ...(flags['assert-gate-generation']
          ? { assertGateGeneration: flags['assert-gate-generation'] }
          : {}),
      });

      // Extend the generic deletion contract to the configured tenant filesystem
      // tree. Filesystem data is tenant-owned only when isolation is enabled;
      // otherwise the configured root is the shared data home and must be left
      // untouched (preserving the historical database-only behavior).
      const filesystem = await this.handleFilesystem(tenantId, dryRun, flags['database-only']);

      // Stable machine-readable contract on stdout — the only thing on stdout.
      // The database result keys are preserved; the filesystem outcome is added
      // as a nested object so existing database automation keeps working.
      // Await the write so the payload is fully flushed to a pipe before the
      // process.exit(0) below (needed to terminate the lingering postgres-js
      // pool); process.exit can otherwise truncate an in-flight async write.
      const json = `${JSON.stringify({ ...result, filesystem })}\n`;
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(json, (err) => (err ? reject(err) : resolve()));
      });

      const totalRows = Object.values(result.rowCounts).reduce((sum, value) => sum + value, 0);
      this.logToStderr(
        chalk.green(
          `✓ ${dryRun ? 'Dry run complete' : 'Tenant data deleted and verified'} — ${totalRows} row(s)`
        )
      );
      await flushStderr();
      process.exit(0);
    } catch (error) {
      const message = tenantDeleteErrorMessage(error);
      this.logToStderr(chalk.red(`✗ ${message}`));
      if (error instanceof TenantDeletionVerificationError) {
        this.logToStderr(chalk.red(`  Remaining tables: ${error.tables.join(', ')}`));
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
