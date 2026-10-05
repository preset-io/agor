/** `agor tenant restriction inspect`: read every controller's recorded intent; an empty array never means the tenant may be served. */

import { createDatabase, getDatabaseUrl, readTenantRestrictionState } from '@agor/core/db';
import type { TenantRestrictionRecord } from '@agor/core/types';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { flushStderr, writeStdoutJson } from '../../../lib/tenant-portability.js';
import {
  EXIT_APPLIED,
  EXIT_FAILURE,
  tenantRestrictionErrorLine,
  tenantRestrictionFailure,
} from '../../../lib/tenant-restriction.js';

export default class TenantRestrictionInspect extends Command {
  static override summary = 'Read a tenant restriction intent';
  static override description =
    "Print every controller's recorded restriction intent for one tenant as a single JSON array on stdout, " +
    'ordered by controller id. Runs non-interactively against the runtime database (PostgreSQL-only) without ' +
    'the daemon. An empty array only means this database holds no recorded intent; it is not evidence that the ' +
    'tenant may be served, and a recorded row is not evidence that anything was contained. ' +
    'The latest update time (the reactivation event cutoff) is printed on stderr only. ' +
    'Exit codes: 0 read (including empty); 3 the runtime is not PostgreSQL and holds no restriction state; ' +
    '1 any other failure, with {"error":<code>} on stderr.';

  static override examples = ['<%= config.bin %> <%= command.id %> --tenant-id acme-corp'];

  static override flags = {
    'tenant-id': Flags.string({ description: 'Tenant id to read', required: true }),
  };

  async run(): Promise<void> {
    let tenantId: string;
    try {
      const { flags } = await this.parse(TenantRestrictionInspect);
      tenantId = flags['tenant-id'];
    } catch (error) {
      const { code } = tenantRestrictionFailure(error);
      this.logToStderr(tenantRestrictionErrorLine(code === 'failed' ? 'invalid_command' : code));
      await flushStderr();
      return process.exit(EXIT_FAILURE);
    }

    let records: TenantRestrictionRecord[];
    let resumeAfter: number | undefined;
    try {
      const db = createDatabase({ url: getDatabaseUrl() });
      ({ records, resumeAfter } = await readTenantRestrictionState(db, tenantId));
    } catch (error) {
      const { exitCode, code } = tenantRestrictionFailure(error);
      this.logToStderr(tenantRestrictionErrorLine(code));
      await flushStderr();
      return process.exit(exitCode);
    }

    await writeStdoutJson(records);
    const closed = records.filter((record) => record.phase !== 'active').length;
    this.logToStderr(
      chalk.green(
        `✓ ${records.length} recorded restriction(s) for ${chalk.cyan(tenantId)} — ` +
          `${chalk.cyan(closed)} closed`
      )
    );
    // Human audit only: the stdout record shape stays fixed for strict parsers.
    if (resumeAfter !== undefined) {
      this.logToStderr(
        chalk.dim(`  Event cutoff (latest update): ${new Date(resumeAfter).toISOString()}`)
      );
    }
    await flushStderr();
    process.exit(EXIT_APPLIED);
  }
}
