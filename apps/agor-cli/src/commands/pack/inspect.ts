/**
 * `agor pack inspect` — validate a `.agorpack` locally and summarize it.
 * Offline: reads the zip, checks every entry name, size, and hash.
 */

import { AgorPackReader } from '@agor/core/agor-pack';
import { fileByteSource } from '@agor/core/agor-pack/file-source';
import { agorPackArchivedNotes, agorPackOutsideLinksNote } from '@agor/core/types';
import { Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BaseCommand } from '../../base-command';

export default class PackInspect extends BaseCommand {
  static override summary = 'Validate and summarize a .agorpack file';
  static override examples = ['<%= config.bin %> <%= command.id %> ada.agorpack'];

  static override args = {
    file: Args.string({ description: 'Path to the .agorpack file', required: true }),
  };

  static override flags = {
    json: Flags.boolean({ description: 'Print the manifest as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PackInspect);
    let reader: AgorPackReader | undefined;
    try {
      reader = await AgorPackReader.open(await fileByteSource(args.file));
      // Re-hash every entry, not just the central directory.
      for (const entry of reader.manifest.entries) {
        const stream = await reader.openStream(entry.path);
        for await (const _chunk of stream) {
          // drain
        }
      }
      const { manifest } = reader;
      if (flags.json) {
        this.log(JSON.stringify(manifest, null, 2));
        return;
      }
      this.log(
        `${chalk.bold('.agorpack')} v${manifest.version} from Agor ${manifest.source.agor_version}, ` +
          `exported ${manifest.created_at} by ${manifest.source.exported_by.name ?? manifest.source.exported_by.email ?? 'unknown'}`
      );
      this.log(
        `Sections: ${manifest.options.sections.join(', ') || 'none'}; sessions: ${manifest.options.sessions}`
      );
      for (const teammate of manifest.teammates) {
        const s = teammate.sections;
        this.log(
          `\n${teammate.emoji ?? '🤖'} ${chalk.bold(teammate.display_name)} (${teammate.key})`
        );
        this.log(
          `  repo ${teammate.repo.slug}${teammate.repo.local_home ? ' (framework teammate, full tree)' : ''}`
        );
        const parts = [
          s.board ? `board ${s.board.objects} objects` : null,
          s.knowledge ? `knowledge ${s.knowledge.documents} docs` : null,
          s.artifacts !== null ? `${s.artifacts} artifacts` : null,
          s.schedules !== null ? `${s.schedules} schedules` : null,
          s.sessions ? `${s.sessions.count} sessions` : null,
          s.uploads ? `${s.uploads.count} attachments` : null,
          s.claude_memory ? `${s.claude_memory.files} Claude memory files` : null,
          s.git
            ? `git ${s.git.unpushed_commits} local commits, ${s.git.dirty_files} changed files`
            : null,
        ].filter(Boolean);
        this.log(`  ${parts.join(' · ')}`);
        for (const note of [
          ...agorPackArchivedNotes(s.archived_skipped),
          agorPackOutsideLinksNote(s.knowledge?.outside_links),
        ]) {
          if (note) this.log(chalk.dim(`  ${note}`));
        }
        const r = teammate.requirements;
        if (r.env_vars.length) this.log(`  env vars: ${r.env_vars.map((v) => v.name).join(', ')}`);
        if (r.mcp_servers.length) this.log(`  MCP: ${r.mcp_servers.map((m) => m.name).join(', ')}`);
        for (const warning of teammate.warnings) this.log(chalk.yellow(`  ! ${warning}`));
      }
      this.log(chalk.green(`\n✓ ${manifest.entries.length} entries verified`));
    } catch (error) {
      this.error(`Invalid pack: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      reader?.close();
    }
  }
}
