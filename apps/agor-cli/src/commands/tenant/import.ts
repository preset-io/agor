/**
 * `agor tenant import` — restore a tenant from a versioned archive directory.
 * The archive is validated in full before any mutation; the database is restored
 * transactionally and the filesystem tree through staging plus atomic
 * publication. The operation is idempotent by operation: a fully-applied import
 * is a no-op success, and an interrupted one can be re-run to completion. A
 * single stable JSON summary is written to stdout; audit lines go to stderr.
 */

import { createDatabase, getDatabaseUrl } from '@agor/core/db';
import {
  importTenant,
  MalformedArchiveError,
  readManifest,
  TenantPortabilityUnsupportedError,
  UnsafeArchivePathError,
} from '@agor/core/tenant-portability';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  EXIT_FAILURE,
  flushStderr,
  formatPortabilityError,
  resolveTenantFilesystem,
  writeStdoutJson,
} from '../../lib/tenant-portability.js';

export default class TenantImport extends Command {
  static override summary = 'Restore one tenant from a verified archive';
  static override description =
    'Import (restore) a single tenant from a versioned archive directory into a standalone multi-tenant ' +
    'PostgreSQL runtime. Validates the archive before mutating, requires an empty destination or the ' +
    'identical prior operation, restores the database transactionally and the filesystem via staging + ' +
    'atomic publish, and is idempotent by operation id.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --archive /path/to/archive',
    '<%= config.bin %> <%= command.id %> --archive ./out --tenant-id new-tenant',
  ];

  static override flags = {
    archive: Flags.string({
      description: 'Archive directory to restore from',
      required: true,
    }),
    'tenant-id': Flags.string({
      description:
        'Destination tenant id (defaults to the archive tenant; a different id re-homes into an empty destination)',
    }),
    'database-only': Flags.boolean({
      description: 'Restore only the database, skipping the tenant filesystem tree',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(TenantImport);

    try {
      this.logToStderr(chalk.bold(`📥 Importing tenant from ${flags.archive}`));

      // Read the manifest to learn the effective destination tenant, then resolve
      // its filesystem root (only when isolation is enabled and files are wanted).
      const requestedTenantId = flags['tenant-id'];
      const manifest = await readManifest(flags.archive);
      const effectiveTenantId = requestedTenantId ?? manifest.tenantId;
      let filesystemRoot: string | undefined;
      if (!flags['database-only'] && manifest.filesystem.included) {
        const resolved = await resolveTenantFilesystem(effectiveTenantId);
        if (resolved) filesystemRoot = resolved.root;
      }

      const db = createDatabase({ url: getDatabaseUrl() });
      const result = await importTenant(db, {
        archivePath: flags.archive,
        ...(requestedTenantId ? { tenantId: requestedTenantId } : {}),
        ...(filesystemRoot ? { filesystemRoot } : {}),
        log: (message) => this.logToStderr(chalk.dim(`  ${message}`)),
      });
      await writeStdoutJson(result);
      const summary = result.alreadyApplied
        ? 'already applied (no changes)'
        : `restored ${result.database.totalRows} row(s) and ${result.filesystem.fileCount} file(s)`;
      this.logToStderr(
        chalk.green(`✓ Tenant ${chalk.cyan(result.tenantId)} imported — ${summary}`)
      );
      await flushStderr();
      process.exit(0);
    } catch (error) {
      this.logToStderr(formatPortabilityError(error));
      if (error instanceof MalformedArchiveError || error instanceof UnsafeArchivePathError) {
        this.logToStderr(chalk.dim('  The archive was rejected before any data was modified.'));
      }
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
