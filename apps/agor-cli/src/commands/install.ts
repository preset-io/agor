import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  AGENTIC_TOOL_INTEGRATIONS,
  findRestorableAgenticTools,
  getAgenticToolInstallSlug,
  type InstallableAgenticTool,
  installManagedIntegration,
  listManagedAgorVersions,
  normalizeAgenticToolName,
  removeManagedAgorVersion,
} from '../lib/agentic-tool-integrations.js';

/**
 * Whether an empty tool set means the user gave us nothing to do.
 *
 * `--prune` alone is valid housekeeping, and `--restore` that finds nothing is a
 * legitimate no-op — neither may exit non-zero, or an unattended upgrade script
 * fails on a machine that simply had no tools installed yet.
 */
export function requiresToolSelection(selection: {
  toolCount: number;
  prune: boolean;
  restore: boolean;
}): boolean {
  return selection.toolCount === 0 && !selection.prune && !selection.restore;
}

export default class Install extends Command {
  static description = 'Install version-aligned agentic tool support for Agor';
  static strict = false;
  static args = { tool: Args.string({ description: 'Agentic tool to install', required: false }) };
  static flags = {
    all: Flags.boolean({ description: 'Install every supported agentic tool', default: false }),
    restore: Flags.boolean({
      description: 'Reinstall the agentic tools you had on your previous Agor version',
      default: false,
    }),
    prune: Flags.boolean({
      description: 'Remove managed tool directories belonging to other Agor versions',
      default: false,
    }),
  };
  static examples = [
    '<%= config.bin %> <%= command.id %> claude',
    '<%= config.bin %> <%= command.id %> claude codex',
    '<%= config.bin %> <%= command.id %> --all',
    '<%= config.bin %> <%= command.id %> --restore',
    '<%= config.bin %> <%= command.id %> --restore --prune',
  ];

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(Install);
    const requested = argv as string[];
    const selectors = [flags.all && '--all', flags.restore && '--restore'].filter(Boolean);
    if (selectors.length > 1) this.error('Use --all or --restore, not both.');
    if (selectors.length > 0 && requested.length > 0) {
      this.error(`Use tool names or ${selectors[0]}, not both.`);
    }

    const agorVersion = process.env.AGOR_INTEGRATION_VERSION ?? this.config.version;
    const tools = await this.resolveTools(requested, flags, agorVersion);

    if (
      requiresToolSelection({
        toolCount: tools.length,
        prune: flags.prune,
        restore: flags.restore,
      })
    ) {
      this.error('Choose at least one agentic tool, or use --all or --restore.');
    }

    for (const tool of tools) {
      const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
      this.log(chalk.bold(`\nInstalling ${definition.displayName} for Agor ${agorVersion}…`));
      await installManagedIntegration(tool, agorVersion);
      this.log(chalk.green(`✓ ${definition.displayName} is installed`));
    }

    if (flags.prune) await this.prune(agorVersion);
  }

  private async resolveTools(
    requested: string[],
    flags: { all: boolean; restore: boolean },
    agorVersion: string
  ): Promise<InstallableAgenticTool[]> {
    if (flags.restore) {
      const restorable = await findRestorableAgenticTools(agorVersion);
      if (!restorable) {
        this.log('No agentic tools from a previous Agor version were found — nothing to restore.');
        return [];
      }
      this.log(
        `Restoring ${restorable.tools
          .map((tool) => getAgenticToolInstallSlug(tool))
          .join(', ')} from Agor ${restorable.version}.`
      );
      return restorable.tools;
    }

    const names = flags.all ? Object.keys(AGENTIC_TOOL_INTEGRATIONS) : requested;
    const normalized = names.map(normalizeAgenticToolName);
    const unknown = names.filter((_, index) => !normalized[index]);
    if (unknown.length > 0) {
      this.error(
        `Unknown agentic tool: ${unknown.join(', ')}. Choose from ${Object.keys(AGENTIC_TOOL_INTEGRATIONS).join(', ')}.`
      );
    }
    return normalized as InstallableAgenticTool[];
  }

  private async prune(agorVersion: string): Promise<void> {
    const stale = (await listManagedAgorVersions()).filter((version) => version !== agorVersion);
    if (stale.length === 0) {
      this.log('\nNo managed tool directories from other Agor versions to remove.');
      return;
    }
    for (const version of stale) {
      await removeManagedAgorVersion(version);
      this.log(chalk.green(`✓ Removed managed tools for Agor ${version}`));
    }
  }
}
