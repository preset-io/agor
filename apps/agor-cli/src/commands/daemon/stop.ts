/**
 * `agor daemon stop` - Stop daemon gracefully
 */

import { getDaemonUrl } from '@agor/core/config';
import { Command } from '@oclif/core';
import chalk from 'chalk';
import { isInstalledPackage } from '../../lib/context.js';
import { getDaemonPid, getManagedDaemonInstanceId, stopDaemon } from '../../lib/daemon-manager.js';
import { probeAgorDaemon } from '../../lib/daemon-probe.js';

export default class DaemonStop extends Command {
  static description = 'Stop daemon gracefully';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    // Check if running in production mode
    if (!isInstalledPackage()) {
      this.log(chalk.red('✗ Daemon lifecycle commands only work in production mode.'));
      this.log('');
      this.log(chalk.bold('In development, stop the daemon with:'));
      this.log(`  ${chalk.cyan('Use Ctrl+C in the daemon terminal')}`);
      this.log('');
      this.exit(1);
    }

    try {
      const daemonUrl = await getDaemonUrl();
      const probe = await probeAgorDaemon(daemonUrl);
      const pid = getDaemonPid();
      const expectedInstanceId = getManagedDaemonInstanceId();

      if (pid === null) {
        if (probe.running) {
          throw new Error(
            `An Agor daemon is running at ${daemonUrl}, but it is not managed by this CLI. Stop its launchd/systemd service, container, or foreground terminal instead.`
          );
        }
        this.log(chalk.yellow('⚠ Daemon is not running'));
        this.log('');
        return;
      }

      if (!expectedInstanceId || probe.managedInstanceId !== expectedInstanceId) {
        throw new Error(
          `Refusing to signal PID ${pid}: it cannot be verified as the CLI-managed Agor daemon at ${daemonUrl}. Remove stale ~/.agor/daemon.pid and ~/.agor/daemon.instance files only after verifying that PID yourself.`
        );
      }

      const stopped = stopDaemon();

      if (!stopped) {
        this.log(chalk.yellow('⚠ Daemon is not running'));
        this.log('');
        return;
      }

      this.log(chalk.green('✓ Daemon stopped successfully'));
      this.log('');
    } catch (error) {
      this.log(chalk.red('✗ Failed to stop daemon'));
      this.log('');
      this.log(`Error: ${(error as Error).message}`);
      this.log('');
      this.exit(1);
    }
  }
}
