/**
 * `agor tenant export` — write a deterministic, versioned archive of one
 * tenant's database rows and configured filesystem tree to a directory the
 * caller supplies. Agor is agnostic of how that directory is transported or
 * mounted. A single stable JSON summary is written to stdout; audit lines go to
 * stderr. No row or file contents, and no secrets, are ever printed.
 */

import { createDatabase, getDatabaseUrl } from '@agor/core/db';
import {
  assertValidTenantId,
  exportTenant,
  InvalidTenantIdError,
  TenantPortabilityUnsupportedError,
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

export default class TenantExport extends Command {
  static override description =
    'Export all data for a single tenant to a versioned archive directory: tenant-owned database rows, ' +
    'the configured tenant filesystem tree, a manifest with hashes and schema/migration identity, and a ' +
    'tenant/operation binding. Deterministic for identical data. ' +
    'Precondition: quiesce tenant writes for the duration so the archive is consistent.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp --archive /path/to/archive',
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp --archive ./out --database-only',
  ];

  static override flags = {
    'tenant-id': Flags.string({
      description: 'Tenant id to export',
      required: true,
    }),
    archive: Flags.string({
      description: 'Destination archive directory (must be empty or not yet exist)',
      required: true,
    }),
    'database-only': Flags.boolean({
      description: 'Export only the database, skipping the tenant filesystem tree',
      default: false,
    }),
    'operation-id': Flags.string({
      description: 'Operation id to bind into the archive manifest (generated when omitted)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(TenantExport);
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
      let filesystemRoot: string | undefined;
      if (!flags['database-only']) {
        const resolved = await resolveTenantFilesystem(tenantId);
        if (resolved) {
          filesystemRoot = resolved.root;
        } else {
          this.logToStderr(
            chalk.dim('  Filesystem isolation is disabled; exporting the database only.')
          );
        }
      }

      this.logToStderr(
        chalk.bold(`📦 Exporting tenant ${chalk.cyan(tenantId)} to ${flags.archive}`)
      );
      const db = createDatabase({ url: getDatabaseUrl() });
      const result = await exportTenant(db, tenantId, {
        archivePath: flags.archive,
        ...(flags['operation-id'] ? { operationId: flags['operation-id'] } : {}),
        ...(filesystemRoot ? { filesystemRoot } : {}),
        log: (message) => this.logToStderr(chalk.dim(`  ${message}`)),
      });
      await writeStdoutJson(result);
      this.logToStderr(
        chalk.green(
          `✓ Exported ${result.database.totalRows} row(s) and ${result.filesystem.fileCount} file(s) — operation ${chalk.cyan(result.operationId)}`
        )
      );
      await flushStderr();
      process.exit(0);
    } catch (error) {
      this.logToStderr(formatPortabilityError(error));
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
