import {
  AGENTIC_TOOL_INTEGRATIONS,
  resolveAgenticToolSelectionPolicy,
  resolveManagedAgenticToolVersion,
} from '@agor/core/agentic-integrations';
import { loadConfig } from '@agor/core/config';
import { diagnoseGit } from '@agor/git';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { diagnoseAgenticTools } from '../lib/agentic-tool-diagnostics.js';
import { listManagedAgorVersions } from '../lib/agentic-tool-integrations.js';
import { diagnoseWebTerminalRuntime } from '../lib/optional-capabilities.js';

export default class Doctor extends Command {
  static description = 'Check this Agor installation and its agentic tools';
  static flags = {
    json: Flags.boolean({ description: 'Print machine-readable JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Doctor);
    const agorVersion = resolveManagedAgenticToolVersion(this.config.version) as string;
    const git = await diagnoseGit();
    const webTerminal = await diagnoseWebTerminalRuntime();
    const agenticTools = await diagnoseAgenticTools(agorVersion);
    const staleVersions = (await listManagedAgorVersions()).filter(
      (version) => version !== agorVersion
    );
    const policy = await resolveAgenticToolSelectionPolicy(await loadConfig());
    if (flags.json) {
      this.log(
        JSON.stringify(
          {
            ok: git.status === 'ready',
            git,
            optionalCapabilities: { webTerminal },
            policy,
            staleVersions,
            agenticTools,
          },
          null,
          2
        )
      );
      return;
    }
    this.log(chalk.bold('Agor doctor\n'));
    this.log(`${chalk.green('✓')} Node.js ${process.version}`);
    this.log(`${chalk.green('✓')} Agor CLI is executable`);
    if (git.status === 'ready') {
      this.log(`${chalk.green('✓')} Git ${git.version} is executable (${git.binary})`);
    } else {
      this.log(`${chalk.red('✗')} ${git.detail}`);
    }
    this.log('');
    this.log(chalk.bold('Optional capabilities'));
    if (webTerminal.status === 'ready') {
      this.log(`  ${chalk.green('✓')} Web terminal runtime: ready`);
    } else {
      this.log(`  ${chalk.yellow('○')} Web terminal runtime: unavailable (optional)`);
      if (webTerminal.detail) this.log(chalk.dim(`      ${webTerminal.detail}`));
      this.log(chalk.dim(`      ${webTerminal.docs}`));
    }
    this.log('');
    this.log(chalk.bold('Agentic tools'));
    this.log(`  Policy: ${policy.mode}; source: ${policy.source}`);
    const selected = new Set(policy.selected);
    for (const item of agenticTools) {
      const marker =
        item.status === 'ready'
          ? chalk.green('✓')
          : selected.has(item.id)
            ? chalk.red('✗')
            : chalk.dim('○');
      this.log(
        `  ${marker} ${AGENTIC_TOOL_INTEGRATIONS[item.id].displayName}: ${item.status}${selected.has(item.id) ? ' (selected)' : ''}`
      );
      if (item.detail && selected.has(item.id)) this.log(chalk.dim(`      ${item.detail}`));
    }
    if (staleVersions.length > 0)
      this.log(chalk.yellow(`\n  Stale Agor versions: ${staleVersions.join(', ')}`));
    if (policy.source === 'missing-manifest')
      this.log(chalk.yellow('\n  No local selection manifest. Run interactive `agor install`.'));
    else this.log(chalk.dim('\n  Repair without changing selection: agor install --sync'));
  }
}
