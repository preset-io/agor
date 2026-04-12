/**
 * `agor daemon logs` - View daemon logs
 */

import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { isInstalledPackage } from '../../lib/context.js';
import { getLogFilePath, readLogs } from '../../lib/daemon-manager.js';

export default class DaemonLogs extends Command {
  static description = 'View daemon logs';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --lines 100',
    '<%= config.bin %> <%= command.id %> -n 200',
  ];

  static flags = {
    lines: Flags.integer({
      char: 'n',
      description: 'Number of lines to display',
      default: 50,
      min: 1,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DaemonLogs);

    // Check if running in production mode
    if (!isInstalledPackage()) {
      this.log(chalk.yellow('⚠ Daemon logs are only available in production mode.'));
      this.log('');
      this.log(chalk.bold('In development, view daemon output in the terminal where you ran:'));
      this.log(`  ${chalk.cyan('cd apps/agor-daemon && pnpm dev')}`);
      this.log('');
      this.exit(1);
    }

    const logFile = getLogFilePath();
    const logs = readLogs(flags.lines);

    this.log(chalk.bold(`\nDaemon Logs (last ${flags.lines} lines)`));
    this.log(chalk.dim('─'.repeat(50)));
    this.log(chalk.dim(`Log file: ${logFile}`));
    this.log('');
    this.log(logs);
    this.log('');
  }
}
