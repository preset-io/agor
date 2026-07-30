/**
 * `agor tenant inspect` — print a bounded, machine-readable inventory/proof of a
 * single tenant's database rows and configured filesystem tree. Contents and
 * secrets are never printed; only counts, hashes, and identifiers. A single
 * stable JSON object is written to stdout; audit lines go to stderr.
 */

import {
  assertValidTenantId,
  createDatabase,
  getDatabaseUrl,
  InvalidTenantIdError,
  inspectTenant,
  TenantPortabilityUnsupportedError,
} from '@agor/core/db';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  EXIT_FAILURE,
  EXIT_INVALID_INPUT,
  flushStderr,
  portabilityErrorMessage,
  resolveTenantFilesystem,
  writeStdoutJson,
} from '../../lib/tenant-portability.js';

export default class TenantInspect extends Command {
  static override description =
    'Inspect a single tenant in a standalone multi-tenant PostgreSQL runtime: emit a bounded, ' +
    'machine-readable inventory of tenant-owned database rows and configured tenant filesystem data. ' +
    'Prints counts, hashes, and identifiers only — never row or file contents.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp',
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp --database-only',
  ];

  static override flags = {
    'tenant-id': Flags.string({
      description: 'Tenant id to inspect',
      required: true,
    }),
    'database-only': Flags.boolean({
      description: 'Inspect only the database, skipping the tenant filesystem tree',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(TenantInspect);
    const tenantId = flags['tenant-id'];

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
      let filesystemRoot: string | undefined;
      if (!flags['database-only']) {
        const resolved = await resolveTenantFilesystem(tenantId);
        if (resolved) {
          filesystemRoot = resolved.root;
        } else {
          this.logToStderr(
            chalk.dim('  Filesystem isolation is disabled; inspecting the database only.')
          );
        }
      }

      const db = createDatabase({ url: getDatabaseUrl() });
      const result = await inspectTenant(db, tenantId, { filesystemRoot });
      await writeStdoutJson(result);
      this.logToStderr(
        chalk.green(
          `✓ Inspected tenant ${chalk.cyan(tenantId)} — ${result.database.totalRows} row(s) across ${result.database.tenantTableCount} table(s)`
        )
      );
      await flushStderr();
      process.exit(0);
    } catch (error) {
      this.logToStderr(chalk.red(`✗ ${portabilityErrorMessage(error)}`));
      if (error instanceof TenantPortabilityUnsupportedError) {
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
