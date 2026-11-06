/**
 * `agor pack import` — upload a `.agor`, show the dry-run, and optionally
 * apply it. Importing the same file again returns the existing result.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { uploadPackChunked } from '@agor/core/agor-pack/upload-client';
import { shortId } from '@agor/core/db';
import type { AgorPackImport } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';
import { packJson } from '../../lib/pack/http';

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
    const client = await this.connectToDaemon();
    try {
      const bearer = await this.resolveHttpBearer();
      const daemonUrl = this.daemonUrl as string;
      const { size } = await stat(args.file);
      const hash = createHash('sha256');
      await pipeline(createReadStream(args.file), hash);
      this.logToStderr(chalk.dim(`Uploading ${args.file} (${size} bytes)…`));
      // Resumable: running the command again sends only the missing chunks.
      const file = await open(args.file, 'r');
      let receipt: AgorPackImport;
      try {
        let reported = -1;
        receipt = await uploadPackChunked({
          size,
          sha256: hash.digest('hex'),
          readChunk: async (start, end) => {
            const buffer = Buffer.alloc(end - start);
            await file.read(buffer, 0, buffer.byteLength, start);
            return buffer;
          },
          send: (path, init) =>
            fetch(`${daemonUrl.replace(/\/$/, '')}${path}`, {
              ...init,
              body: init.body as RequestInit['body'],
              headers: { Authorization: `Bearer ${bearer}`, ...(init.headers ?? {}) },
            }),
          onProgress: (sent, total) => {
            const percent = Math.floor((sent / total) * 100);
            if (percent >= reported + 10 || sent === total) {
              reported = percent;
              this.logToStderr(chalk.dim(`  ${percent}%`));
            }
          },
        });
      } finally {
        await file.close();
      }
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
        // Apply runs in the background; follow the receipt until the rows are in.
        while (receipt.status === 'applying') {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          receipt = await packJson<AgorPackImport>(
            daemonUrl,
            bearer,
            `/agor-pack/imports/${receipt.import_id}`
          );
        }
        if (receipt.status === 'failed') {
          throw new Error(`${receipt.error ?? 'apply failed'} (run the command again to resume)`);
        }
        for (const result of receipt.results) {
          this.logToStderr(
            chalk.green(`✓ ${result.display_name} → branch ${shortId(result.branch_id)}`) +
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
