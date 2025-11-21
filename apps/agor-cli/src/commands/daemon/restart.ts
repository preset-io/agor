/**
 * `agor daemon restart` - Restart daemon
 */

import { isDaemonRunning } from '@agor/core/api';
import { getDaemonUrl } from '@agor/core/config';
import { Command } from '@oclif/core';
import chalk from 'chalk';
import { getDaemonPath, isInstalledPackage } from '../../lib/context.js';
import { startDaemon, stopDaemon } from '../../lib/daemon-manager.js';

export default class DaemonRestart extends Command {
  static description = 'Restart daemon';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    // Check if running in production mode
    if (!isInstalledPackage()) {
      this.log(chalk.red('✗ Daemon lifecycle commands only work in production mode.'));
      this.log('');
      this.log(chalk.bold('In development, restart the daemon with:'));
      this.log(`  1. ${chalk.cyan('Use Ctrl+C in the daemon terminal')}`);
      this.log(`  2. ${chalk.cyan('cd apps/agor-daemon && pnpm dev')}`);
      this.log('');
      this.exit(1);
    }

    // Get daemon binary path
    const daemonPath = getDaemonPath();
    if (!daemonPath) {
      this.log(chalk.red('✗ Daemon binary not found'));
      this.log('');
      this.log('Your installation may be corrupted. Try reinstalling:');
      this.log(`  ${chalk.cyan('npm install -g agor-live')}`);
      this.log('');
      this.exit(1);
    }

    try {
      // Stop daemon if running
      const stopped = stopDaemon();
      if (stopped) {
        this.log(chalk.green('✓ Daemon stopped'));
      }

      // Wait a moment before starting
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Start daemon
      const pid = startDaemon(daemonPath);

      this.log(chalk.green('✓ Daemon restarted successfully'));
      this.log('');
      this.log(`  PID: ${chalk.cyan(String(pid))}`);
      this.log('');
      this.log('View logs with:');
      this.log(`  ${chalk.cyan('agor daemon logs')}`);
      this.log('');

      // Wait a moment and check if it's actually running
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const daemonUrl = await getDaemonUrl();
      const running = await isDaemonRunning(daemonUrl);

      if (!running) {
        this.log(chalk.yellow('⚠ Daemon started but not responding'));
        this.log('');
        this.log('Check logs for errors:');
        this.log(`  ${chalk.cyan('agor daemon logs')}`);
        this.log('');
      }
    } catch (error) {
      this.log(chalk.red('✗ Failed to restart daemon'));
      this.log('');
      this.log(`Error: ${(error as Error).message}`);
      this.log('');
      this.exit(1);
    }
  }
}
