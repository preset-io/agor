/**
 * `agor tenant gate inspect` — report a tenant's write-gate state, optionally
 * checking that the gate is still held at a specific generation (the "held
 * continuously" proof). Exit 0 when active/consistent, 3 when a `--expect-generation`
 * check fails (loss or replacement). A single stable JSON object is written to
 * stdout; audit lines go to stderr.
 */

import {
  assertValidTenantId,
  createDatabase,
  getDatabaseUrl,
  InvalidTenantIdError,
  inspectTenantWriteGate,
  TenantWriteGateUnsupportedError,
} from '@agor/core/db';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  EXIT_FAILURE,
  EXIT_INVALID_INPUT,
  flushStderr,
  formatPortabilityError,
  writeStdoutJson,
} from '../../../lib/tenant-portability.js';

/** Exit code when a --expect-generation continuity check fails. */
const EXIT_CONTINUITY_FAILED = 3;

export default class TenantGateInspect extends Command {
  static override summary = 'Inspect a tenant write gate';
  static override description =
    "Inspect a tenant's write gate. With --expect-generation, also verify the gate is still held at " +
    'that exact generation (fail-closed on loss or replacement); exit 3 if not. PostgreSQL-only.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp',
    '<%= config.bin %> <%= command.id %> --tenant-id acme-corp --expect-generation <gen>',
  ];

  static override flags = {
    'tenant-id': Flags.string({ description: 'Tenant id to inspect', required: true }),
    'expect-generation': Flags.string({
      description: 'Assert the gate is still held at this exact generation',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(TenantGateInspect);
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
      const db = createDatabase({ url: getDatabaseUrl() });
      const result = await inspectTenantWriteGate(db, tenantId, {
        ...(flags['expect-generation'] ? { expectGeneration: flags['expect-generation'] } : {}),
      });
      await writeStdoutJson({ tenantId, ...result });

      if (flags['expect-generation'] !== undefined && result.heldContinuously !== true) {
        this.logToStderr(
          chalk.red(
            `✗ Gate for ${chalk.cyan(tenantId)} is NOT held continuously at the expected generation`
          )
        );
        await flushStderr();
        process.exit(EXIT_CONTINUITY_FAILED);
      }
      this.logToStderr(
        chalk.green(
          `✓ Gate for ${chalk.cyan(tenantId)} is ${result.active ? 'active' : 'inactive'}`
        )
      );
      await flushStderr();
      process.exit(0);
    } catch (error) {
      this.logToStderr(formatPortabilityError(error));
      if (error instanceof TenantWriteGateUnsupportedError) {
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
