/**
 * `agor tenant export` — write a deterministic, versioned archive of one
 * tenant's database rows and configured filesystem tree to a directory the
 * caller supplies. Agor is agnostic of how that directory is transported or
 * mounted. A single stable JSON summary is written to stdout; audit lines go to
 * stderr. No row or file contents, and no secrets, are ever printed.
 */

import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { getTenantDataRoot } from '@agor/core/config';
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
  static override summary = 'Export one tenant to a verified archive';
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
    'transfer-key-out': Flags.string({
      description:
        'Reseal every secret under a new one-time transfer key and write that key to this file ' +
        '(0600, must not exist). The key never enters the archive; hand it to the destination ' +
        'operator separately for `agor tenant rewrap-secrets`.',
    }),
    'source-key-env': Flags.string({
      description: 'Env var holding the source master secret (with --transfer-key-out)',
      default: 'AGOR_MASTER_SECRET',
    }),
    'files-subset': Flags.boolean({
      description:
        'Export only branch SDK homes, uploads, and local-home teammate trees; repositories and ' +
        'other checkouts are re-cloned at the destination (pair with import --target-layout clone)',
      default: false,
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
        } else if (flags['files-subset']) {
          // Self-hosted (no isolation): the data home holds the subset paths.
          filesystemRoot = getTenantDataRoot();
        } else {
          this.logToStderr(
            chalk.dim('  Filesystem isolation is disabled; exporting the database only.')
          );
        }
      }
      let transferKey: { fromKey: string; toKey: string } | undefined;
      if (flags['transfer-key-out']) {
        const fromKey = process.env[flags['source-key-env']];
        if (!fromKey) {
          this.logToStderr(chalk.red(`  ${flags['source-key-env']} is not set.`));
          await flushStderr();
          process.exit(EXIT_INVALID_INPUT);
        }
        transferKey = { fromKey: fromKey as string, toKey: randomBytes(32).toString('hex') };
        // Write the key first (exclusive): an export without its key is useless.
        await writeFile(flags['transfer-key-out'], `${transferKey.toKey}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
      }

      this.logToStderr(
        chalk.bold(`📦 Exporting tenant ${chalk.cyan(tenantId)} to ${flags.archive}`)
      );
      const db = createDatabase({ url: getDatabaseUrl() });
      const result = await exportTenant(db, tenantId, {
        archivePath: flags.archive,
        ...(flags['operation-id'] ? { operationId: flags['operation-id'] } : {}),
        ...(filesystemRoot ? { filesystemRoot } : {}),
        ...(transferKey ? { transferKey } : {}),
        filesSubset: flags['files-subset'],
        agorRelease: this.config.version,
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
          chalk.dim('  Check the database configuration (AGOR_DB_DIALECT, DATABASE_URL).')
        );
      }
      await flushStderr();
      process.exit(EXIT_FAILURE);
    }
  }
}
