import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { diagnoseAgenticTools } from '../lib/agentic-tool-diagnostics.js';

export default class Doctor extends Command {
  static description = 'Check this Agor installation and its agentic tools';
  static flags = {
    json: Flags.boolean({ description: 'Print machine-readable JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Doctor);
    const agenticTools = await diagnoseAgenticTools();
    if (flags.json) {
      this.log(JSON.stringify({ ok: true, agenticTools }, null, 2));
      return;
    }
    this.log(chalk.bold('Agor doctor\n'));
    this.log(`${chalk.green('✓')} Node.js ${process.version}`);
    this.log(`${chalk.green('✓')} Agor CLI is executable`);
    this.log('');
    await this.config.runCommand('agentic-tools', []);
  }
}
