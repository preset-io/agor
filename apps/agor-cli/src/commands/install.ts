import {
  type InstallableAgenticTool,
  resolveManagedAgenticToolIntegration,
} from '@agor/core/agentic-integrations';
import { loadConfig } from '@agor/core/config';
import { Command } from '@oclif/core';
import chalk from 'chalk';
import {
  AGENTIC_TOOL_INTEGRATIONS,
  installManagedIntegration,
  listManagedAgorVersions,
  listManagedToolDirectories,
  readManagedIntegrationManifest,
  removeManagedAgorVersion,
  removeManagedInstallDebris,
  removeManagedIntegration,
} from '../lib/agentic-tool-integrations.js';

export default class Install extends Command {
  static description =
    'Align agentic tool packages with config.yaml and remove unconfigured or stale installs';
  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    await this.parse(Install);
    const agorVersion = process.env.AGOR_INTEGRATION_VERSION ?? this.config.version;
    const config = await loadConfig();
    const configured = config.agentic_tools?.installed ?? [];

    this.log(chalk.bold(`Agentic tool package alignment for Agor ${agorVersion}`));
    this.log(
      configured.length > 0
        ? `Configured: ${configured.join(', ')}`
        : 'Configured: none (all managed agentic tool packages will be removed)'
    );

    for (const tool of configured) {
      const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
      if (await this.isAligned(tool, agorVersion)) {
        this.log(chalk.green(`✓ ${definition.displayName} is already aligned`));
        continue;
      }
      this.log(chalk.bold(`Installing ${definition.displayName}@${agorVersion}…`));
      await installManagedIntegration(tool, agorVersion);
      this.log(chalk.green(`✓ ${definition.displayName} installed`));
    }

    const installed = await listManagedToolDirectories(agorVersion);
    for (const tool of installed) {
      if (configured.includes(tool)) continue;
      await removeManagedIntegration(tool, agorVersion);
      this.log(
        chalk.green(`✓ Removed unconfigured ${AGENTIC_TOOL_INTEGRATIONS[tool].displayName}`)
      );
    }

    for (const version of await listManagedAgorVersions()) {
      if (version === agorVersion) continue;
      await removeManagedAgorVersion(version);
      this.log(chalk.green(`✓ Removed managed tools for stale Agor ${version}`));
    }

    const debris = await removeManagedInstallDebris(agorVersion);
    if (debris.length > 0)
      this.log(chalk.green(`✓ Removed ${debris.length} interrupted install(s)`));
    this.log(chalk.green.bold('Agentic tool packages are aligned.'));
  }

  private async isAligned(tool: InstallableAgenticTool, version: string): Promise<boolean> {
    const manifest = await readManagedIntegrationManifest(tool, version);
    if (!manifest) return false;
    try {
      const integration = await resolveManagedAgenticToolIntegration(tool, version);
      return integration.AGOR_INTEGRATION_VERSION === version && Boolean(integration.sdk);
    } catch {
      return false;
    }
  }
}
