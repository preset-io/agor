/**
 * `agor daemon start` - Start daemon as a detached background process.
 *
 * Validates config (including services: section) up front, then spawns
 * the daemon in the background via daemon-manager. The CLI exits
 * immediately; logs go to ~/.agor/logs/daemon.log.
 *
 * Port/host are set via config.yaml (daemon.port / daemon.host) or env vars (PORT).
 */

import { resolve } from 'node:path';
import type { AgorConfig } from '@agor/core/config';
import { loadConfig, loadConfigFromFile } from '@agor/core/config';
import { validateAllowedTiers, validateServiceDependencies } from '@agor-live/client';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getDaemonPath, isInstalledPackage } from '../../lib/context.js';
import { getDaemonPid, startDaemon } from '../../lib/daemon-manager.js';

export default class DaemonStart extends Command {
  static description = 'Start the Agor daemon in the background';

  static examples = [
    '<%= config.bin %> daemon start',
    '<%= config.bin %> daemon start --config /etc/agor/config.yaml',
    '<%= config.bin %> daemon start --foreground',
  ];

  static flags = {
    config: Flags.string({
      char: 'c',
      description: 'Path to config file (default: ~/.agor/config.yaml)',
    }),
    foreground: Flags.boolean({
      char: 'f',
      description: 'Run daemon in the foreground (blocks until stopped)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DaemonStart);

    // 1. Load & validate config
    const config = flags.config ? await this.loadConfigFromPath(flags.config) : await loadConfig();

    this.validateServicesConfig(config);

    // 2. Check if already running
    const existingPid = getDaemonPid();
    if (existingPid !== null) {
      this.log(chalk.yellow(`Daemon already running (PID ${existingPid})`));
      return;
    }

    // 3. Foreground mode: import and run in-process (blocks forever)
    if (flags.foreground) {
      this.log(chalk.bold('Starting Agor daemon in foreground...'));
      this.logServicesInfo(config);
      try {
        const daemonModule = await this.importDaemonModule();
        await daemonModule.startDaemon({ config });
      } catch (error) {
        this.log(chalk.red('Failed to start daemon:'));
        this.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
        this.exit(1);
      }
      return;
    }

    // 4. Background mode (default): spawn detached process
    this.log(chalk.bold('Starting Agor daemon...'));
    this.logServicesInfo(config);

    const daemonPath = this.resolveDaemonEntrypoint();

    // Pass config path to the child process via env var
    const env: Record<string, string> = {};
    if (flags.config) {
      env.AGOR_CONFIG_PATH = resolve(flags.config);
    }

    try {
      const pid = startDaemon(daemonPath, env);
      this.log(chalk.green(`Daemon started (PID ${pid})`));
      this.log(chalk.dim('  Logs: ~/.agor/logs/daemon.log'));
    } catch (error) {
      this.log(chalk.red('Failed to start daemon:'));
      this.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
      this.exit(1);
    }
  }

  private validateServicesConfig(config: AgorConfig): void {
    if (!config.services) return;

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

  private logServicesInfo(config: AgorConfig): void {
    if (!config.services) return;
    const nonDefault = Object.entries(config.services).filter(
      ([, tier]) => tier !== undefined && tier !== 'on'
    );
    if (nonDefault.length > 0) {
      this.log(chalk.dim(`  Services: ${nonDefault.map(([g, t]) => `${g}=${t}`).join(', ')}`));
    }
  }

  private async importDaemonModule(): Promise<{
    startDaemon: (opts?: Record<string, unknown>) => Promise<void>;
  }> {
    if (isInstalledPackage()) {
      const { pathToFileURL } = await import('node:url');
      const { getDaemonModulePath } = await import('../../lib/context.js');
      const modulePath = getDaemonModulePath();
      if (!modulePath) {
        this.log(chalk.red('Failed to locate bundled daemon module'));
        this.exit(1);
      }
      return import(pathToFileURL(modulePath).href);
    }
    return import('@agor/daemon');
  }

  private resolveDaemonEntrypoint(): string {
    const bundledPath = getDaemonPath();
    if (bundledPath) return bundledPath;

    // Development mode: resolve to daemon's main.ts via tsx
    // This won't be used in production — dev users run `pnpm dev` directly
    this.log(
      chalk.yellow('Development mode detected. Use `pnpm dev` in apps/agor-daemon/ for hot-reload.')
    );
    this.log(chalk.yellow('Starting daemon without watch mode...'));

    // Resolve to compiled daemon entrypoint
    const { fileURLToPath } = require('node:url');
    const path = require('node:path');
    const dirname =
      typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    return resolve(dirname, '../../../agor-daemon/dist/main.js');
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
}
