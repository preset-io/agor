/**
 * `agor daemon restart` - Restart daemon
 */

import { assertConfiguredAgenticToolsReady } from '@agor/core/agentic-integrations';
import {
  type AgorConfig,
  getDaemonUrl,
  loadConfig,
  loadConfigFromFile,
  resolveDaemonUrl,
} from '@agor/core/config';
import { resolveDatabaseUrl } from '@agor/core/db';
import { Command } from '@oclif/core';
import chalk from 'chalk';
import { getDaemonStartMigrationBlocker } from '../../lib/check-migrations.js';
import { getDaemonPath, isInstalledPackage } from '../../lib/context.js';
import {
  getDaemonPid,
  getManagedDaemonIdentity,
  startDaemon,
  stopDaemon,
} from '../../lib/daemon-manager.js';
import { isExpectedManagedDaemon, probeAgorDaemon } from '../../lib/daemon-probe.js';
import { assertLocalContextUnlocked } from '../../lib/local-context.js';

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

    // Validate the PID first so a crashed daemon cannot leave a stale config
    // or URL record that influences the replacement process.
    const existingPid = getDaemonPid();
    const identity = getManagedDaemonIdentity();
    let restartConfig: AgorConfig;
    try {
      restartConfig = identity?.configPath
        ? await loadConfigFromFile(identity.configPath)
        : await loadConfig();
    } catch (error) {
      this.log(chalk.red('✗ Failed to load daemon configuration'));
      this.log(error instanceof Error ? error.message : String(error));
      this.exit(1);
    }
    await assertLocalContextUnlocked(restartConfig);

    // Validate the new package set before stopping a currently healthy daemon.
    try {
      await assertConfiguredAgenticToolsReady(restartConfig);
    } catch (error) {
      this.log(chalk.red('✗ Agentic tools are not ready'));
      this.log(error instanceof Error ? error.message : String(error));
      this.exit(1);
    }

    let migrationBlocker: string | null;
    try {
      migrationBlocker = await getDaemonStartMigrationBlocker(
        resolveDatabaseUrl({ config: restartConfig })
      );
    } catch (error) {
      this.log(chalk.red('✗ Failed to check database migration status'));
      this.log(error instanceof Error ? error.message : String(error));
      this.exit(1);
    }
    if (migrationBlocker) {
      process.stderr.write(chalk.red(migrationBlocker));
      this.exit(1);
    }

    const oldDaemonUrl = identity?.daemonUrl ?? (await getDaemonUrl());
    const replacementDaemonUrl = resolveDaemonUrl(restartConfig);

    try {
      if (
        replacementDaemonUrl !== oldDaemonUrl &&
        (await probeAgorDaemon(replacementDaemonUrl)).running
      ) {
        throw new Error(
          `An Agor daemon is already running at the replacement URL ${replacementDaemonUrl}. Stop its service, container, or foreground terminal before restarting.`
        );
      }

      // Stop daemon if running
      let stopped = false;
      if (existingPid !== null) {
        const managedInstanceId = identity?.instanceId;
        if (!(await isExpectedManagedDaemon(oldDaemonUrl, managedInstanceId))) {
          throw new Error(
            `Refusing to signal PID ${existingPid}: it cannot be verified as the CLI-managed Agor daemon at ${oldDaemonUrl}.`
          );
        }
        stopped = stopDaemon();
      } else if ((await probeAgorDaemon(oldDaemonUrl)).running) {
        throw new Error(
          `An Agor daemon is running at ${oldDaemonUrl}, but it is not managed by this CLI. Stop its service, container, or foreground terminal instead.`
        );
      }
      if (stopped) {
        this.log(chalk.green('✓ Daemon stopped'));
      }

      // Wait a moment before starting
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Start daemon
      const restartEnv = identity?.configPath
        ? { AGOR_CONFIG_PATH: identity.configPath }
        : undefined;
      const pid = startDaemon(daemonPath, restartEnv, {
        daemonUrl: replacementDaemonUrl,
        ...(identity?.configPath ? { configPath: identity.configPath } : {}),
      });

      this.log(chalk.green('✓ Daemon restarted successfully'));
      this.log('');
      this.log(`  PID: ${chalk.cyan(String(pid))}`);
      this.log('');
      this.log('View logs with:');
      this.log(`  ${chalk.cyan('agor daemon logs')}`);
      this.log('');

      // Wait a moment and check if it's actually running
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const running = await isExpectedManagedDaemon(
        replacementDaemonUrl,
        getManagedDaemonIdentity()?.instanceId
      );

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
