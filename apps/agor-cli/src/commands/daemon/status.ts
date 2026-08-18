/**
 * `agor daemon status` - Check daemon status
 */

import { getDaemonUrl } from '@agor/core/config';
import { Command } from '@oclif/core';
import chalk from 'chalk';
import { isAgorInitialized, isInstalledPackage } from '../../lib/context.js';
import {
  getDaemonPid,
  getLogFilePath,
  getManagedDaemonIdentity,
  getPidFilePath,
} from '../../lib/daemon-manager.js';
import { probeAgorDaemon } from '../../lib/daemon-probe.js';

export default class DaemonStatus extends Command {
  static description = 'Check daemon status';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    await this.parse(DaemonStatus);
    // Status is diagnostic and must remain usable before init and during an
    // identity upgrade. PID validation also clears stale managed config state.
    const pid = getDaemonPid();
    const identity = getManagedDaemonIdentity();

    // Check if Agor is initialized
    const initialized = await isAgorInitialized();

    // Get daemon info
    const daemonUrl = identity?.daemonUrl ?? (await getDaemonUrl());
    const running = initialized ? (await probeAgorDaemon(daemonUrl)).running : false;

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
