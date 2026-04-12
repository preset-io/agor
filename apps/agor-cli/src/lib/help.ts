/**
 * Custom Help Class
 *
 * Extends oclif's default help to show our hero banner and daemon status
 */

import { isDaemonRunning } from '@agor-live/client';
import { getDaemonUrl } from '@agor-live/client/config';
import { Help } from '@oclif/core';
import chalk from 'chalk';
import { getBanner } from './banner.js';

export default class CustomHelp extends Help {
  async showRootHelp(): Promise<void> {
    // Show hero banner first
    this.log(getBanner());

    // Check daemon status
    const daemonUrl = await getDaemonUrl();
    const running = await isDaemonRunning(daemonUrl);

    this.log(''); // Empty line
    if (running) {
      this.log(
        `  ${chalk.green('●')} Daemon: ${chalk.green('Running')} ${chalk.dim(`(${daemonUrl})`)}`
      );
    } else {
      this.log(
        `  ${chalk.red('●')} Daemon: ${chalk.red('Not Running')} ${chalk.dim(`(${daemonUrl})`)}`
      );
      this.log(`  ${chalk.dim('→')} Start with: ${chalk.cyan('agor daemon start')}`);
    }
    this.log(''); // Empty line

    // Then show standard help
    return super.showRootHelp();
  }
}
