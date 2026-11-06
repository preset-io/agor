/**
 * `agor pack export` — export AI teammates to a portable `.agor` file.
 */

import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AGOR_PACK,
  AGOR_PACK_DEFAULT_SESSION_MODE,
  type AgorPackExportRequest,
  type AgorPackManifest,
} from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';
import { packFetch, packJson } from '../../lib/pack/http';

const SESSION_MODES: Record<string, NonNullable<AgorPackExportRequest['sessions']>> = {
  none: 'none',
  '90d': 'last_90_days',
  all: 'all',
};
const DEFAULT_SESSIONS_FLAG = Object.keys(SESSION_MODES).find(
  (key) => SESSION_MODES[key] === AGOR_PACK_DEFAULT_SESSION_MODE
) as string;

export default class PackExport extends BaseCommand {
  static override summary = 'Export AI teammates to a .agor file';
  static override description =
    'Writes one secret-free .agor file with the selected teammates: board, Knowledge, artifacts, ' +
    'schedules, Claude memory, attachments, git history and uncommitted files, and session ' +
    'history (last 90 days by default). Credentials never leave this install; the import shows ' +
    'what to reconnect.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> 01933e4a -o ada.agor',
    '<%= config.bin %> <%= command.id %> 01933e4a 01933e4b --sessions all -o team.agor',
  ];

  static override strict = false;

  static override args = {
    teammate: Args.string({ description: 'Teammate branch ID (one or more)', required: true }),
  };

  static override flags = {
    output: Flags.string({ char: 'o', description: 'Output file', required: true }),
    sessions: Flags.string({
      description: 'Session history to include',
      options: Object.keys(SESSION_MODES),
      default: DEFAULT_SESSIONS_FLAG,
    }),
    'include-others-sessions': Flags.boolean({
      description: "Also include other people's sessions on these teammates",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(PackExport);
    const client = await this.connectToDaemon();
    try {
      const branchIds: string[] = [];
      for (const id of argv as string[]) {
        const branch = await client.service('branches').get(id);
        branchIds.push(branch.branch_id);
      }
      const bearer = await this.resolveHttpBearer();
      const daemonUrl = this.daemonUrl as string;
      this.logToStderr(chalk.dim(`Packing ${branchIds.length} teammate(s)…`));
      const result = await packJson<{
        export_id: string;
        ref: string;
        size: number;
        manifest: AgorPackManifest;
      }>(daemonUrl, bearer, '/agor-pack/exports', {
        branch_ids: branchIds,
        sessions: SESSION_MODES[flags.sessions] ?? AGOR_PACK_DEFAULT_SESSION_MODE,
        include_others_sessions: flags['include-others-sessions'],
      } satisfies AgorPackExportRequest);
      const response = await packFetch(
        daemonUrl,
        bearer,
        `/agor-pack/downloads/${result.export_id}/${result.ref}`
      );
      const output = flags.output.endsWith(AGOR_PACK.extension)
        ? flags.output
        : `${flags.output}${AGOR_PACK.extension}`;
      await pipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(output, { mode: 0o600 })
      );
      for (const teammate of result.manifest.teammates) {
        this.logToStderr(
          `  ${teammate.emoji ?? '🤖'} ${chalk.bold(teammate.display_name)}${
            teammate.warnings.length ? chalk.yellow(` — ${teammate.warnings.join(' ')}`) : ''
          }`
        );
      }
      this.logToStderr(chalk.green(`✓ Wrote ${output} (${result.size} bytes)`));
      this.log(
        JSON.stringify({
          output,
          bytes: result.size,
          content_sha256: result.manifest.content_sha256,
          teammates: result.manifest.teammates.map((t) => t.display_name),
        })
      );
    } catch (error) {
      this.error(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await this.cleanupClient(client);
    }
  }
}
