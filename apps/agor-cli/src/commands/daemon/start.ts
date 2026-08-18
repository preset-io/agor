/**
 * `agor daemon start` - Start daemon as a detached background process.
 *
 * Loads config up front, then spawns the daemon in the background via
 * daemon-manager. The CLI exits
 * immediately; logs go to ~/.agor/logs/daemon.log.
 *
 * Port/host are set via config.yaml (daemon.port / daemon.host) or env vars (PORT).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertConfiguredAgenticToolsReady } from '@agor/core/agentic-integrations';
import type { AgorConfig } from '@agor/core/config';
import { resolveDaemonUrl } from '@agor/core/config';
import { resolveDatabaseUrl } from '@agor/core/db';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getDaemonStartMigrationBlocker } from '../../lib/check-migrations.js';
import { getDaemonPath, isInstalledPackage } from '../../lib/context.js';
import { loadDaemonConfigWithDeploymentIdentity } from '../../lib/daemon-deployment-config.js';
import { getDaemonPid, startDaemon } from '../../lib/daemon-manager.js';
import { probeAgorDaemon } from '../../lib/daemon-probe.js';
import { assertLocalContextUnlocked } from '../../lib/local-context.js';

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
    const result = await loadDaemonConfigWithDeploymentIdentity(flags.config);
    const config = result.config;
    if (result.migrated) {
      this.log(chalk.green(`✓ Added daemon.deployment_id: ${result.migrated.deploymentId}`));
      this.log(chalk.dim(`Backup: ${result.migrated.backupPath}`));
    }
    await assertLocalContextUnlocked(config);
    const daemonUrl = resolveDaemonUrl(config);

    // 2. Check if already running
    const existingPid = getDaemonPid();
    if (existingPid !== null) {
      this.log(chalk.yellow(`Daemon already running (PID ${existingPid})`));
      return;
    }
    if ((await probeAgorDaemon(daemonUrl)).running) {
      this.error(
        `An Agor daemon is already running at ${daemonUrl}, but it is not managed by this CLI. Stop its service, container, or foreground terminal instead.`
      );
    }

    // 3. Fail before detaching when an upgrade still needs package reconciliation.
    await this.failOnUnreadyAgenticTools(config);

    // 4. Fail fast on pending migrations. The daemon performs this same
    //    check on startup, but in background mode its stderr is redirected
    //    into ~/.agor/logs/daemon.log — so the error would be invisible at
    //    the user's terminal. Surface it inline here before spawning.
    await this.failOnPendingMigrations(resolveDatabaseUrl({ config }));

    // 5. Foreground mode: import and run in-process (blocks forever)
    if (flags.foreground) {
      this.log(chalk.bold('Starting Agor daemon in foreground...'));
      try {
        const daemonModule = await this.importDaemonModule();
        await daemonModule.startDaemon({
          config,
          ...(flags.config ? { configPath: resolve(flags.config) } : {}),
        });
      } catch (error) {
        this.log(chalk.red('Failed to start daemon:'));
        this.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
        this.exit(1);
      }
      return;
    }

    // 6. Background mode (default): spawn detached process
    this.log(chalk.bold('Starting Agor daemon...'));

    const daemonPath = this.resolveDaemonEntrypoint();

    // Pass config path to the child process via env var
    const env: Record<string, string> = {};
    if (flags.config) {
      env.AGOR_CONFIG_PATH = resolve(flags.config);
    }

    try {
      const pid = startDaemon(daemonPath, env, {
        daemonUrl,
        ...(flags.config ? { configPath: resolve(flags.config) } : {}),
      });
      this.log(chalk.green(`Daemon started (PID ${pid})`));
      this.log(chalk.dim('  Logs: ~/.agor/logs/daemon.log'));
    } catch (error) {
      this.log(chalk.red('Failed to start daemon:'));
      this.log(chalk.red(`  ${error instanceof Error ? error.message : String(error)}`));
      this.exit(1);
    }
  }

  private async failOnUnreadyAgenticTools(config: AgorConfig): Promise<void> {
    try {
      await assertConfiguredAgenticToolsReady(config);
    } catch (error) {
      this.error(
        chalk.red(
          `✗ Agentic tools are not ready\n${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  private async failOnPendingMigrations(dbUrl: string): Promise<void> {
    let blocker: string | null;
    try {
      blocker = await getDaemonStartMigrationBlocker(dbUrl);
    } catch (error) {
      // Don't swallow the failure silently — the old behavior (pre-regression)
      // was to warn and continue, but that is what led to the daemon dying in
      // the background with no terminal-visible error. If we can't even read
      // migration status, refuse to start and surface why. Route through
      // this.error() so the message hits stderr and the process exits 1.
      this.error(
        chalk.red(
          `✗ Failed to check database migration status\n  ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }

    if (blocker === null) return;

    // Write directly to stderr so the message is not swallowed by oclif's
    // log level filters and is clearly separated from any stdout consumers.
    process.stderr.write(chalk.red(blocker));
    this.exit(1);
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
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '../../../agor-daemon/dist/main.js');
  }
}
