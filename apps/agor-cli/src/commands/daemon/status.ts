/**
 * `agor daemon status` - Check daemon status
 */

import { isDaemonRunning } from '@agor-live/client';
import { getDaemonUrl } from '@agor-live/client/config';
import { Command } from '@oclif/core';
import chalk from 'chalk';
import { isAgorInitialized, isInstalledPackage } from '../../lib/context.js';
import { getDaemonPid, getLogFilePath, getPidFilePath } from '../../lib/daemon-manager.js';

export default class DaemonStatus extends Command {
  static description = 'Check daemon status';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    // Check if Agor is initialized
    const initialized = await isAgorInitialized();

    // Get daemon info
    const daemonUrl = await getDaemonUrl();
    const pid = getDaemonPid();
    const running = initialized ? await isDaemonRunning(daemonUrl) : false;

    this.log(chalk.bold('\nDaemon Status'));
    this.log(chalk.dim('─'.repeat(50)));
    this.log('');

    // Status
    if (!initialized) {
      this.log(`  Status: ${chalk.yellow('Not Initialized ⚠')}`);
    } else if (running) {
      this.log(`  Status: ${chalk.green('Running ✓')}`);
    } else {
      this.log(`  Status: ${chalk.red('Not Running ✗')}`);
    }

    // PID
    if (pid !== null) {
      this.log(`  PID:    ${chalk.cyan(String(pid))}`);
    }

    // URL
    this.log(`  URL:    ${chalk.cyan(daemonUrl)}`);

    // Context
    if (isInstalledPackage()) {
      this.log(`  Mode:   ${chalk.cyan('Production')}`);
    } else {
      this.log(`  Mode:   ${chalk.cyan('Development')}`);
    }

    // File paths
    this.log('');
    this.log(chalk.bold('Files:'));
    this.log(`  PID:    ${chalk.dim(getPidFilePath())}`);
    this.log(`  Logs:   ${chalk.dim(getLogFilePath())}`);

    this.log('');

    // Instructions
    if (!initialized) {
      this.log(chalk.bold('To initialize Agor:'));
      this.log(`  ${chalk.cyan('agor init')}`);
      this.log('');
    } else if (!running) {
      if (isInstalledPackage()) {
        this.log(chalk.bold('To start the daemon:'));
        this.log(`  ${chalk.cyan('agor daemon start')}`);
      } else {
        this.log(chalk.bold('To start the daemon:'));
        this.log(`  ${chalk.cyan('cd apps/agor-daemon && pnpm dev')}`);
      }
      this.log('');
    }
  }
}
