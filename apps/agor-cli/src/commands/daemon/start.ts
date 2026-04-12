/**
 * `agor daemon start` - Config-aware daemon startup for headless/k8s deployments.
 *
 * Reads config.yaml (including services: section), then boots the daemon
 * in-process with the resolved config.
 *
 * Port/host are set via config.yaml (daemon.port / daemon.host) or env vars (PORT).
 * Compose with sync: `agor daemon sync --config ... && agor daemon start --config ...`
 */

import { pathToFileURL } from 'node:url';
import type { AgorConfig } from '@agor/core/config';
import { loadConfig, loadConfigFromFile } from '@agor/core/config';
import { validateAllowedTiers, validateServiceDependencies } from '@agor/core/types';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getDaemonModulePath, isInstalledPackage } from '../../lib/context.js';

export default class DaemonStart extends Command {
  static description = 'Start daemon with config-aware boot (services, resources)';

  static examples = [
    '<%= config.bin %> daemon start',
    '<%= config.bin %> daemon start --config /etc/agor/config.yaml',
  ];

  static flags = {
    config: Flags.string({
      char: 'c',
      description: 'Path to config file (default: ~/.agor/config.yaml)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DaemonStart);

    // 1. Load config
    const config = flags.config ? await this.loadConfigFromPath(flags.config) : await loadConfig();

    // 2. Validate services config early (fail fast before boot)
    if (config.services) {
      const tierViolations = validateAllowedTiers(config.services);
      if (tierViolations.length > 0) {
        this.log(chalk.red('Services configuration error:'));
        for (const v of tierViolations) {
          this.log(
            chalk.red(`  '${v.group}' cannot be '${v.tier}' (allowed: ${v.allowed.join(', ')})`)
          );
        }
        this.exit(1);
      }

      const depViolations = validateServiceDependencies(config.services);
      if (depViolations.length > 0) {
        this.log(chalk.yellow('Service dependency warnings (will be auto-promoted at boot):'));
        for (const v of depViolations) {
          this.log(
            chalk.yellow(
              `  '${v.service}' requires '${v.dependency}' to be at least '${v.requiredTier}'`
            )
          );
        }
      }
    }

    // 3. Start daemon in-process
    this.log(chalk.bold('Starting Agor daemon...'));

    if (config.services) {
      const nonDefault = Object.entries(config.services).filter(
        ([, tier]) => tier !== undefined && tier !== 'on'
      );
      if (nonDefault.length > 0) {
        this.log(chalk.dim(`  Services: ${nonDefault.map(([g, t]) => `${g}=${t}`).join(', ')}`));
      }
    }

    this.log('');

    try {
      const daemonModule = isInstalledPackage()
        ? await import(pathToFileURL(this.getBundledDaemonModulePath()).href)
        : await import('@agor/daemon');
      const { startDaemon } = daemonModule;
      await startDaemon({ config });
    } catch (error) {
      this.log(chalk.red('Failed to start daemon:'));
      this.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
      this.exit(1);
    }
  }

  private async loadConfigFromPath(configPath: string): Promise<AgorConfig> {
    try {
      return await loadConfigFromFile(configPath);
    } catch (error) {
      this.log(chalk.red(`Failed to load config from ${configPath}:`));
      this.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
      this.exit(1);
    }
  }

  private getBundledDaemonModulePath(): string {
    const daemonModulePath = getDaemonModulePath();
    if (!daemonModulePath) {
      this.log(chalk.red('Failed to locate bundled daemon module'));
      this.exit(1);
    }
    return daemonModulePath;
  }
}
