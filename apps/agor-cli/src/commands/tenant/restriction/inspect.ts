/**
 * `agor tenant restriction inspect` — read back every controller's recorded
 * restriction intent for one tenant. Read-only proof Job for the Data Plane
 * Agent; needs only the runtime database configuration (`DATABASE_URL`).
 *
 * An empty array means no controller has recorded intent for this tenant in
 * THIS database. It is not proof that the tenant may be served: a fresh or
 * restored runtime must receive its own authoritative restriction first.
 */

import { createDatabase, getDatabaseUrl, readTenantRestrictionIntents } from '@agor/core/db';
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
    try {
      const db = createDatabase({ url: getDatabaseUrl() });
      records = await readTenantRestrictionIntents(db, tenantId);
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
    await flushStderr();
    process.exit(EXIT_APPLIED);
  }
}
