/**
 * `agor tenant rewrap-secrets` — reseal one tenant's secrets from one master
 * key to another (e.g. from an export's transfer key to this runtime's key).
 * Keys are read from environment variables named by flags, never from
 * arguments. Prints one JSON proof (counts only, never values).
 */

import { createDatabase, getDatabaseUrl } from '@agor/core/db';
import { assertValidTenantId, rewrapTenantSecrets } from '@agor/core/tenant-portability';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  EXIT_FAILURE,
  EXIT_INVALID_INPUT,
  flushStderr,
  formatPortabilityError,
  writeStdoutJson,
} from '../../lib/tenant-portability.js';

export default class TenantRewrapSecrets extends Command {
  static override summary = "Reseal a tenant's secrets under another master key";
  static override description =
    'Re-encrypts every secret in one tenant from the key in --from-env to the key in --to-env, ' +
    'in one transaction, then proves nothing remains readable only with the old key. ' +
    'Idempotent: values already sealed with the new key are left alone.';

  static override examples = [
    'AGOR_TRANSFER_KEY=… <%= config.bin %> <%= command.id %> --tenant-id acme --from-env AGOR_TRANSFER_KEY',
  ];

  static override flags = {
    'tenant-id': Flags.string({ description: 'Tenant id to rewrap', required: true }),
    'from-env': Flags.string({
      description: 'Env var holding the key the secrets are sealed with now',
      required: true,
    }),
    'to-env': Flags.string({
      description: 'Env var holding the key to reseal with',
      default: 'AGOR_MASTER_SECRET',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(TenantRewrapSecrets);
    const fromKey = process.env[flags['from-env']];
    const toKey = process.env[flags['to-env']];
    try {
      assertValidTenantId(flags['tenant-id']);
      if (!fromKey || !toKey) throw new Error('missing key');
    } catch (error) {
      this.logToStderr(
        error instanceof Error && error.message === 'missing key'
          ? chalk.red(`  Set ${flags['from-env']} and ${flags['to-env']}.`)
          : formatPortabilityError(error)
      );
      await flushStderr();
      process.exit(EXIT_INVALID_INPUT);
    }
    try {
      const db = createDatabase({ url: getDatabaseUrl() });
      const proof = await rewrapTenantSecrets(db, {
        tenantId: flags['tenant-id'],
        fromKey: fromKey as string,
        toKey: toKey as string,
      });
      await writeStdoutJson(proof);
      this.logToStderr(
        chalk.green(
          `✓ Resealed ${proof.rewrappedValues} secret(s) in ${proof.tables.length} table(s)`
        )
      );
      await flushStderr();
      process.exit(0);
    } catch (error) {
      this.logToStderr(formatPortabilityError(error));
      await flushStderr();
      process.exit(EXIT_FAILURE);
    }
  }
}
