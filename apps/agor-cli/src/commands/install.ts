import {
  assertManagedAgenticToolInstallReady,
  getAgenticToolInstallDir,
  type InstallableAgenticTool,
  InvalidAgenticToolSelectionManifestError,
  resolveAgenticToolSelectionPolicy,
  resolveManagedAgenticToolVersion,
} from '@agor/core/agentic-integrations';
import type { AgorConfig } from '@agor/core/config';
import { loadConfig } from '@agor/core/config';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import {
  AGENTIC_TOOL_INTEGRATIONS,
  acquireAgenticToolInstallLock,
  installManagedIntegration,
  listManagedAgorVersions,
  listManagedToolDirectories,
  readManagedIntegrationManifest,
  removeManagedAgorVersion,
  removeManagedInstallDebris,
  removeManagedIntegration,
  repairManagedIntegrationPermissions,
  validateInteractiveAgenticToolSelection,
  writeAgenticToolSelectionManifest,
} from '../lib/agentic-tool-integrations.js';

export default class Install extends Command {
  static description =
    'After init, select or reconcile agentic tool packages without recreating Agor';
  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --sync',
  ];
  static flags = {
    sync: Flags.boolean({
      description: 'Reconcile noninteractively without changing the selection',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Install);
    const releaseLock = await acquireAgenticToolInstallLock();
    try {
      await this.reconcile(flags.sync);
    } finally {
      await releaseLock();
    }
  }

  private async reconcile(sync: boolean): Promise<void> {
    const agorVersion = resolveManagedAgenticToolVersion(this.config.version) as string;
    const config = await loadConfig();
    let policy = await resolveInstallSelectionPolicy(config, sync);
    if (policy.mode === 'local-managed' && sync && policy.source === 'missing-manifest') {
      this.error(
        'No locally managed agentic-tool selection exists. Run interactive `agor install` once to choose tools; no packages were changed. For Docker/Kubernetes, declare agentic_tools.installed in config.yaml.'
      );
    }
    if (policy.mode === 'local-managed' && !sync) {
      this.log(chalk.dim('Use ↑/↓ to move, Space to select, and Enter to continue.'));
      const previouslySelected = new Set<InstallableAgenticTool>(
        policy.selected as readonly InstallableAgenticTool[]
      );
      const { selected } = await inquirer.prompt<{ selected: InstallableAgenticTool[] }>([
        {
          type: 'checkbox',
          name: 'selected',
          message: 'Which agentic tools should this deployment support?',
          choices: Object.entries(AGENTIC_TOOL_INTEGRATIONS).map(([value, definition]) => ({
            name: `${definition.displayName} (${definition.packageName}@${agorVersion})`,
            value,
            checked: previouslySelected.has(value as InstallableAgenticTool),
          })),
          validate: validateInteractiveAgenticToolSelection,
        },
      ]);
      await writeAgenticToolSelectionManifest(selected);
      policy = { mode: 'local-managed', selected, source: 'manifest' };
    }
    const configured: readonly InstallableAgenticTool[] = policy.selected;

    this.log(chalk.bold(`Agentic tool package alignment for Agor ${agorVersion}`));
    this.log(
      `Policy: ${policy.mode === 'declarative' ? 'declarative config.yaml' : 'locally managed manifest'}`
    );
    this.log(
      configured.length > 0
        ? `Configured: ${configured.join(', ')}`
        : 'Configured: none (all managed agentic tool packages will be removed)'
    );

    for (const tool of configured) {
      const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
      await repairManagedIntegrationPermissions(tool, agorVersion);
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
      await assertManagedAgenticToolInstallReady(
        tool,
        version,
        getAgenticToolInstallDir(tool, version)
      );
      return true;
    } catch {
      return false;
    }
  }
}

export async function resolveInstallSelectionPolicy(config: AgorConfig, sync: boolean) {
  try {
    return await resolveAgenticToolSelectionPolicy(config);
  } catch (error) {
    if (!sync && error instanceof InvalidAgenticToolSelectionManifestError) {
      return {
        mode: 'local-managed',
        selected: [] as InstallableAgenticTool[],
        source: 'missing-manifest' as const,
      };
    }
    throw error;
  }
}
