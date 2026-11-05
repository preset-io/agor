/**
 * `agor pack export` — export AI teammates to a portable `.agorpack` file.
 */

import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AGOR_PACK,
  AGOR_PACK_DEFAULT_SESSION_MODE,
  AGOR_PACK_SECTIONS,
  type AgorPackExportRequest,
  type AgorPackManifest,
  type AgorPackSection,
} from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';
import { packFetch, packJson } from '../../lib/pack/http';

const SESSION_MODES: Record<string, AgorPackExportRequest['sessions']> = {
  none: 'none',
  '30d': 'last_30_days',
  all: 'all',
};
const DEFAULT_SESSIONS_FLAG = Object.keys(SESSION_MODES).find(
  (key) => SESSION_MODES[key] === AGOR_PACK_DEFAULT_SESSION_MODE
) as string;

export default class PackExport extends BaseCommand {
  static override summary = 'Export AI teammates to a .agorpack file';
  static override description =
    'Writes one secret-free .agorpack with the selected teammates: board, Knowledge, artifacts, ' +
    'schedules, Claude memory, attachments, git history and uncommitted files, and optionally ' +
    'session history. Credentials never leave this install; the import shows what to reconnect.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> 01933e4a -o ada.agorpack',
    '<%= config.bin %> <%= command.id %> 01933e4a 01933e4b --sections board,knowledge --sessions 30d -o team.agorpack',
  ];

  static override strict = false;

  static override args = {
    teammate: Args.string({ description: 'Teammate branch ID (one or more)', required: true }),
  };

  static override flags = {
    output: Flags.string({ char: 'o', description: 'Output file', required: true }),
    sections: Flags.string({
      description: `Comma-separated sections (${AGOR_PACK_SECTIONS.join(', ')}); default: all`,
    }),
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
    const sections = flags.sections
      ? flags.sections.split(',').map((value) => value.trim())
      : [...AGOR_PACK_SECTIONS];
    for (const section of sections) {
      if (!(AGOR_PACK_SECTIONS as readonly string[]).includes(section)) {
        this.error(`Unknown section "${section}". Choose from: ${AGOR_PACK_SECTIONS.join(', ')}`);
      }
    }
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
        sections: sections as AgorPackSection[],
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
