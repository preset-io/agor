/**
 * `agor tenant verify` — prove that a tenant's live data matches a saved archive
 * proof, emitting strict, bounded, machine-readable evidence for automation. It
 * re-derives the tenant's database and filesystem hashes from the running system
 * and compares them to the archive manifest, using only generic runtime-derived
 * identities. Exit code is 0 on a full match and non-zero on any mismatch. A
 * single stable JSON object is written to stdout; audit lines go to stderr.
 */

import { createDatabase, getDatabaseUrl } from '@agor/core/db';
import {
  MalformedArchiveError,
  readManifest,
  TenantPortabilityUnsupportedError,
  verifyTenant,
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

/** Exit code when the archive is valid but the live data does not match. */
const EXIT_MISMATCH = 3;

export default class TenantVerify extends Command {
  static override summary = 'Verify live tenant data against an archive';
  static override description =
    "Verify a tenant's live data against a saved archive proof and emit strict, bounded evidence. " +
    'Compares runtime-derived database identity, re-hashes every tenant table, and (when isolation is ' +
    'enabled) compares the tenant filesystem tree. Exit 0 on a full match, 3 on a mismatch.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --archive /path/to/archive',
    '<%= config.bin %> <%= command.id %> --archive ./out --database-only',
  ];

  static override flags = {
    archive: Flags.string({
      description: 'Archive directory holding the saved proof',
      required: true,
    }),
    'database-only': Flags.boolean({
      description: 'Verify only the database, skipping the tenant filesystem tree',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(TenantVerify);

    try {
      this.logToStderr(chalk.bold(`🔎 Verifying tenant against ${flags.archive}`));
      const manifest = await readManifest(flags.archive);
      const scope = flags['database-only'] ? 'database' : 'full';
      let filesystemRoot: string | undefined;
      if (scope === 'full' && manifest.filesystem.included) {
        const resolved = await resolveTenantFilesystem(manifest.tenantId);
        if (resolved) filesystemRoot = resolved.root;
      }

      const db = createDatabase({ url: getDatabaseUrl() });
      const result = await verifyTenant(db, {
        archivePath: flags.archive,
        scope,
        ...(filesystemRoot ? { filesystemRoot } : {}),
      });
      await writeStdoutJson(result);

      if (result.match) {
        this.logToStderr(
          chalk.green(`✓ Tenant ${chalk.cyan(result.tenantId)} matches the archive proof`)
        );
        await flushStderr();
        process.exit(0);
      }
      this.logToStderr(
        chalk.red(`✗ Tenant ${chalk.cyan(result.tenantId)} does NOT match the archive proof`)
      );
      if (result.database.mismatchCount > 0) {
        this.logToStderr(chalk.dim(`  ${result.database.mismatchCount} database table(s) differ`));
      }
      if (result.filesystem.mismatchCount > 0) {
        this.logToStderr(
          chalk.dim(`  ${result.filesystem.mismatchCount} filesystem path(s) differ`)
        );
      }
      await flushStderr();
      process.exit(EXIT_MISMATCH);
    } catch (error) {
      this.logToStderr(formatPortabilityError(error));
      if (error instanceof MalformedArchiveError) {
        this.logToStderr(chalk.dim('  The archive could not be read or is malformed.'));
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
