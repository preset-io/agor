/**
 * `agor tenant restriction apply` — record one controller-owned restriction
 * command for a tenant in the runtime database. Invoked by the Data Plane Agent
 * as a non-interactive in-Cell Job; it needs only the runtime database
 * configuration (`DATABASE_URL`) and never contacts the daemon.
 *
 * It writes INTENT. It does not authenticate the controller, drain connections,
 * stop processes, or prove that anything already admitted has stopped.
 */

import { applyTenantRestrictionIntent, createDatabase, getDatabaseUrl } from '@agor/core/db';
import type { TenantRestrictionRecord } from '@agor/core/types';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { flushStderr, writeStdoutJson } from '../../../lib/tenant-portability.js';
import {
  buildTenantRestrictionCommand,
  EXIT_APPLIED,
  EXIT_FAILURE,
  tenantRestrictionErrorLine,
  tenantRestrictionFailure,
} from '../../../lib/tenant-restriction.js';

export default class TenantRestrictionApply extends Command {
  static override summary = 'Apply one tenant restriction command';
  static override description =
    'Record a controller-owned restriction command (restrict | prepare_release | activate) for one tenant. ' +
    'Runs non-interactively against the runtime database (PostgreSQL-only) without the daemon, and prints ' +
    '{"record":…,"changed":…} as a single JSON line on stdout. ' +
    'This records intent only: it does not authenticate the controller, close existing connections, stop ' +
    'running work, or prove containment. ' +
    'Exit codes: 0 applied or already in that state (see "changed"); ' +
    '2 conflict — stderr carries {"error":"identity_mismatch|stale_revision|revision_conflict|release_not_prepared"}; ' +
    '3 the runtime is not PostgreSQL and holds no restriction state; 1 any other failure.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp --controller-id agor-cloud-team-suspension-v1 --placement-id cell-7 --operation-id susp-42 --revision 3 --action restrict',
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp --controller-id agor-cloud-team-suspension-v1 --placement-id cell-7 --operation-id rel-43 --revision 4 --action prepare_release',
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp --controller-id agor-cloud-team-suspension-v1 --placement-id cell-7 --operation-id rel-43 --revision 4 --action activate',
  ];

  static override flags = {
    'tenant-id': Flags.string({ description: 'Tenant id the command applies to', required: true }),
    'controller-id': Flags.string({
      description: 'Controller that owns this restriction; composition across controllers is OR',
      required: true,
    }),
    'placement-id': Flags.string({
      description: 'Placement bound to the controller; immutable once recorded',
      required: true,
    }),
    'operation-id': Flags.string({
      description: 'Operation this revision belongs to; activate requires the exact prepared one',
      required: true,
    }),
    revision: Flags.integer({
      description: 'Monotonic revision for this controller; lower revisions are rejected',
      required: true,
    }),
    action: Flags.string({
      description: 'Transition to record',
      options: ['restrict', 'prepare_release', 'activate'],
      required: true,
    }),
  };

  async run(): Promise<void> {
    // Parse failures exit 1: exit 2 is reserved for a recorded-state conflict.
    let command: ReturnType<typeof buildTenantRestrictionCommand>;
    let tenantId: string;
    try {
      const { flags } = await this.parse(TenantRestrictionApply);
      tenantId = flags['tenant-id'];
      command = buildTenantRestrictionCommand(flags);
    } catch (error) {
      const { code } = tenantRestrictionFailure(error);
      this.logToStderr(tenantRestrictionErrorLine(code === 'failed' ? 'invalid_command' : code));
      await flushStderr();
      return process.exit(EXIT_FAILURE);
    }

    let result: { record: TenantRestrictionRecord; changed: boolean };
    try {
      const db = createDatabase({ url: getDatabaseUrl() });
      result = await applyTenantRestrictionIntent(db, tenantId, command, {
        // stdout is the machine-readable contract; the writer's operational
        // line belongs on stderr with the rest of the audit output.
        log: (line) => this.logToStderr(chalk.dim(line)),
      });
    } catch (error) {
      // Bounded stderr failure line only; error text never crosses this boundary.
      const { exitCode, code } = tenantRestrictionFailure(error);
      this.logToStderr(tenantRestrictionErrorLine(code));
      await flushStderr();
      return process.exit(exitCode);
    }

    await writeStdoutJson(result);
    this.logToStderr(
      chalk.green(
        `✓ ${result.changed ? 'Recorded' : 'Already recorded'} ${chalk.cyan(command.action)} ` +
          `for ${chalk.cyan(tenantId)} — phase ${chalk.cyan(result.record.phase)} ` +
          `revision ${chalk.cyan(result.record.revision)}`
      )
    );
    this.logToStderr(
      chalk.dim('  Intent only — this proves no containment of already-admitted work.')
    );
    await flushStderr();
    process.exit(EXIT_APPLIED);
  }
}
