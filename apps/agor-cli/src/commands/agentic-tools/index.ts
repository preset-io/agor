import { resolveManagedAgenticToolVersion } from '@agor/core/agentic-integrations';
import { loadConfig } from '@agor/core/config';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { diagnoseAgenticTools } from '../../lib/agentic-tool-diagnostics.js';
import { listManagedAgorVersions } from '../../lib/agentic-tool-integrations.js';

export default class AgenticTools extends Command {
  static description = 'Show which agentic tools are available to Agor';
  static flags = {
    json: Flags.boolean({ description: 'Print machine-readable JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AgenticTools);
    const agorVersion = resolveManagedAgenticToolVersion(this.config.version) as string;
    const diagnostics = await diagnoseAgenticTools(agorVersion);
    const config = await loadConfig();
    const configured = config.agentic_tools?.installed ?? [];
    const configuredSet = new Set(configured);
    const staleVersions = (await listManagedAgorVersions()).filter(
      (version) => version !== agorVersion
    );
    if (flags.json) {
      this.log(
        JSON.stringify(
          { agorVersion, configured, staleVersions, agenticTools: diagnostics },
          null,
          2
        )
      );
      return;
    }
    this.log(chalk.bold('Agentic tools\n'));
    for (const item of diagnostics) {
      const marker =
        item.status === 'ready'
          ? chalk.green('✓')
          : item.status === 'missing'
            ? chalk.yellow('○')
            : chalk.red('✗');
      this.log(
        `  ${marker} ${chalk.bold(item.name)}  ${item.status}  ${configuredSet.has(item.id) ? chalk.cyan('configured') : chalk.dim('unconfigured')}`
      );
      if (item.version) this.log(chalk.dim(`      ${item.version}`));
      if (item.path) this.log(chalk.dim(`      ${item.path}`));
      if (item.detail && configuredSet.has(item.id)) this.log(chalk.red(`      ${item.detail}`));
      if (item.status !== 'ready' && configuredSet.has(item.id)) {
        this.log(chalk.dim(`      ${item.docsUrl}`));
      }
    }
    if (staleVersions.length > 0) {
      this.log(chalk.yellow(`\n  Stale Agor versions: ${staleVersions.join(', ')}`));
    }
    this.log('');
    this.log(chalk.dim('Run `agor install` to align this state exactly with config.yaml.'));
  }
}
