/**
 * `agor tenant delete` - Permanently delete all data for a single tenant.
 *
 * Operators of a multi-tenant Agor deployment use this to remove a tenant
 * entirely (offboarding, data-removal requests, regulatory erasure). It runs
 * non-interactively (container/Job friendly), talks straight to the database the
 * same way the rest of the runtime does (env/config), and prints a single stable
 * JSON object to stdout for external automation. Human audit logging goes to
 * stderr so stdout stays parseable.
 */

import {
  assertValidTenantId,
  createDatabase,
  deleteTenantData,
  getDatabaseUrl,
  InvalidTenantIdError,
  TenantDeletionUnsupportedError,
  TenantDeletionVerificationError,
} from '@agor/core/db';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';

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

/** Wait until every stderr write queued so far has completed. */
function flushStderr(): Promise<void> {
  return new Promise((resolve) => {
    process.stderr.write('', () => resolve());
  });
}

export default class TenantDelete extends Command {
  static override description =
    'Permanently delete all data belonging to a single tenant (PostgreSQL multi-tenant deployments). Idempotent and verified. ' +
    'Precondition: quiesce the tenant first — stop new tenant-scoped work at the control/auth layer BEFORE running. ' +
    'This command verifies tenant state at scan time and does not by itself prevent a concurrent writer from recreating tenant rows after verification.';

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
      });

      // Stable machine-readable contract on stdout — the only thing on stdout.
      // Await the write so the payload is fully flushed to a pipe before the
      // process.exit(0) below (needed to terminate the lingering postgres-js
      // pool); process.exit can otherwise truncate an in-flight async write.
      const json = `${JSON.stringify(result)}\n`;
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
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
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
