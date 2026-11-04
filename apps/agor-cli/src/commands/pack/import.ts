/**
 * `agor pack import` — upload a `.agorpack`, show the dry-run, and optionally
 * apply it. Importing the same file again returns the existing result.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { AgorPackImport } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';
import { packFetch, packJson } from '../../lib/pack/http';

export default class PackImport extends BaseCommand {
  static override summary = 'Import AI teammates from a .agorpack file';
  static override description =
    'Uploads the pack and prints a dry-run. With --apply, imports the selected teammates as you: ' +
    'schedules arrive disabled, custom MCP servers disabled without credentials, sessions as ' +
    'archived history. Re-importing the same file is a no-op.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> ada.agorpack',
    '<%= config.bin %> <%= command.id %> team.agorpack --apply --teammates t01,t02',
  ];

  static override args = {
    file: Args.string({ description: 'Path to the .agorpack file', required: true }),
  };

  static override flags = {
    apply: Flags.boolean({ description: 'Import after the dry-run', default: false }),
    teammates: Flags.string({ description: 'Comma-separated teammate keys (default: all)' }),
    board: Flags.string({ description: 'Existing board ID to place teammates on (default: new)' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PackImport);
    const client = await this.connectToDaemon();
    try {
      const bearer = await this.resolveHttpBearer();
      const daemonUrl = this.daemonUrl as string;
      const { size } = await stat(args.file);
      this.logToStderr(chalk.dim(`Uploading ${args.file} (${size} bytes)…`));
      const response = await packFetch(daemonUrl, bearer, '/agor-pack/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip', 'Content-Length': String(size) },
        body: Readable.toWeb(createReadStream(args.file)) as never,
        duplex: 'half',
      } as RequestInit);
      let receipt = (await response.json()) as AgorPackImport;
      for (const teammate of receipt.dry_run) {
        const done = teammate.already_imported_branch_id ? chalk.green(' (already imported)') : '';
        this.logToStderr(
          `  ${chalk.bold(teammate.key)} ${teammate.display_name} — repo ${teammate.repo_status}${done}`
        );
        for (const warning of teammate.warnings) this.logToStderr(chalk.yellow(`    ! ${warning}`));
      }
      if (flags.apply) {
        const keys = flags.teammates
          ? flags.teammates.split(',').map((key) => key.trim())
          : receipt.manifest.teammates.map((t) => t.key);
        let boardId: string | null = null;
        if (flags.board) boardId = (await client.service('boards').get(flags.board)).board_id;
        receipt = await packJson<AgorPackImport>(
          daemonUrl,
          bearer,
          `/agor-pack/imports/${receipt.import_id}/apply`,
          { teammates: keys, board_id: boardId }
        );
        for (const result of receipt.results) {
          this.logToStderr(
            chalk.green(`✓ ${result.display_name} → branch ${result.branch_id.slice(0, 8)}`) +
              chalk.dim(` (files: ${result.filesystem})`)
          );
          for (const warning of result.warnings) this.logToStderr(chalk.yellow(`    ! ${warning}`));
        }
      }
      this.log(JSON.stringify(receipt));
    } catch (error) {
      this.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await this.cleanupClient(client);
    }
  }
}
