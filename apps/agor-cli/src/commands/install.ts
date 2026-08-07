import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  AGENTIC_TOOL_INTEGRATIONS,
  type InstallableAgenticTool,
  installManagedIntegration,
  normalizeAgenticToolName,
} from '../lib/agentic-tool-integrations.js';

export default class Install extends Command {
  static description = 'Install version-aligned agentic tool support for Agor';
  static strict = false;
  static args = { tool: Args.string({ description: 'Agentic tool to install', required: false }) };
  static flags = {
    all: Flags.boolean({ description: 'Install every supported agentic tool', default: false }),
  };
  static examples = [
    '<%= config.bin %> <%= command.id %> claude',
    '<%= config.bin %> <%= command.id %> claude codex',
    '<%= config.bin %> <%= command.id %> --all',
  ];

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(Install);
    const requested = argv as string[];
    if (flags.all && requested.length > 0) this.error('Use tool names or --all, not both.');
    const tools = (flags.all ? Object.keys(AGENTIC_TOOL_INTEGRATIONS) : requested) as string[];
    if (tools.length === 0) this.error('Choose at least one agentic tool or use --all.');
    const normalized = tools.map(normalizeAgenticToolName);
    const unknown = tools.filter((_, index) => !normalized[index]);
    if (unknown.length > 0) {
      this.error(
        `Unknown agentic tool: ${unknown.join(', ')}. Choose from ${Object.keys(AGENTIC_TOOL_INTEGRATIONS).join(', ')}.`
      );
    }

    const agorVersion = process.env.AGOR_INTEGRATION_VERSION ?? this.config.version;
    for (const tool of normalized as InstallableAgenticTool[]) {
      const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
      this.log(chalk.bold(`\nInstalling ${definition.displayName} for Agor ${agorVersion}…`));
      await installManagedIntegration(tool, agorVersion);
      this.log(chalk.green(`✓ ${definition.displayName} is installed`));
    }
  }
}
