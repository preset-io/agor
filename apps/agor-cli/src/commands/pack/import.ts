/**
 * `agor pack import` — upload a `.agor`, show the dry-run, and optionally
 * apply it. Importing the same file again returns the existing result.
 */

import { stat } from 'node:fs/promises';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';
import {
  apiKeysProblem,
  applyPack,
  printDryRun,
  redactSecrets,
  uploadPackFile,
} from '../../lib/pack/options';

export default class PackImport extends BaseCommand {
  static override summary = 'Import AI teammates from a .agor file';
  static override description =
    'Uploads the pack and prints a dry-run. With --apply, imports the selected teammates as you: ' +
    'schedules arrive disabled, custom MCP servers disabled without credentials, sessions as ' +
    'archived history. Re-importing the same file is a no-op.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> ada.agor',
    '<%= config.bin %> <%= command.id %> team.agor --apply --teammates t01,t02',
  ];

  static override args = {
    file: Args.string({ description: 'Path to the .agor file', required: true }),
  };

  static override flags = {
    apply: Flags.boolean({ description: 'Import after the dry-run', default: false }),
    teammates: Flags.string({ description: 'Comma-separated teammate keys (default: all)' }),
    board: Flags.string({ description: 'Existing board ID to place teammates on (default: new)' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PackImport);
    // Checked before any request uses it; redacted from every error after.
    const bearer = await this.resolveHttpBearer();
    const keyProblem = apiKeysProblem([
      { key: bearer, label: 'The API key for this Agor (AGOR_API_KEY or your sign-in)' },
    ]);
    if (keyProblem) this.error(keyProblem);
    let client: Awaited<ReturnType<typeof this.connectToDaemon>> | undefined;
    try {
      client = await this.connectToDaemon();
      const daemonUrl = this.daemonUrl as string;
      const { size } = await stat(args.file);
      this.logToStderr(chalk.dim(`Uploading ${args.file} (${size} bytes)…`));
      // Resumable: running the command again sends only the missing chunks.
      let receipt = await uploadPackFile({
        baseUrl: daemonUrl,
        bearer,
        file: args.file,
        log: (line) => this.logToStderr(line),
      });
      printDryRun((line) => this.logToStderr(line), receipt);
      if (flags.apply) {
        const boardId = flags.board
          ? (await client.service('boards').get(flags.board)).board_id
          : null;
        receipt = await applyPack({
          daemonUrl,
          bearer,
          receipt,
          teammates: flags.teammates,
          boardId,
          log: (line) => this.logToStderr(line),
        });
      }
      this.log(JSON.stringify(receipt));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(`Import failed: ${redactSecrets(message, [bearer])}`);
    } finally {
      if (client) await this.cleanupClient(client);
    }
  }
}
