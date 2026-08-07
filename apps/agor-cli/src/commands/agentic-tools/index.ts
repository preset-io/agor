import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { diagnoseAgenticTools } from '../../lib/agentic-tool-diagnostics.js';

export default class AgenticTools extends Command {
  static description = 'Show which agentic tools are available to Agor';
  static flags = {
    json: Flags.boolean({ description: 'Print machine-readable JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AgenticTools);
    const diagnostics = await diagnoseAgenticTools();
    if (flags.json) {
      this.log(JSON.stringify({ agenticTools: diagnostics }, null, 2));
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
      this.log(`  ${marker} ${chalk.bold(item.name)}  ${item.status}`);
      if (item.version) this.log(chalk.dim(`      ${item.version}`));
      if (item.path) this.log(chalk.dim(`      ${item.path}`));
      if (item.detail) this.log(chalk.red(`      ${item.detail}`));
      if (item.status !== 'ready') this.log(chalk.dim(`      ${item.docsUrl}`));
    }
    this.log('');
    this.log(chalk.dim('Agor only requires the agentic tools you choose to use.'));
  }
}
