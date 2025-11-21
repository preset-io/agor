/**
 * `agor daemon start` - Start daemon in background
 */

import { isDaemonRunning } from '@agor/core/api';
import { getDaemonUrl } from '@agor/core/config';
import { checkMigrationStatus, createLocalDatabase } from '@agor/core/db';
import { extractDbFilePath } from '@agor/core/utils/path';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getDaemonPath, isAgorInitialized, isInstalledPackage } from '../../lib/context.js';
import { startDaemon } from '../../lib/daemon-manager.js';

export default class DaemonStart extends Command {
  static description = 'Start daemon in background';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --foreground',
  ];

  static flags = {
    foreground: Flags.boolean({
      char: 'f',
      description: 'Run daemon in foreground (synchronous)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DaemonStart);

    // Check if running in production mode
    if (!isInstalledPackage()) {
      this.log(chalk.red('✗ Daemon lifecycle commands only work in production mode.'));
      this.log('');
      this.log(chalk.bold('In development, start the daemon with:'));
      this.log(`  ${chalk.cyan('cd apps/agor-daemon && pnpm dev')}`);
      this.log('');
      this.exit(1);
    }

    // Check if Agor has been initialized
    const initialized = await isAgorInitialized();
    if (!initialized) {
      this.log(chalk.red('✗ Agor is not initialized'));
      this.log('');
      this.log('Initialize Agor first with:');
      this.log(`  ${chalk.cyan('agor init')}`);
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

    // Check if daemon binary actually exists
    const fs = await import('node:fs');
    if (!fs.existsSync(daemonPath)) {
      this.log(chalk.red('✗ Daemon binary not found'));
      this.log('');
      this.log(`Expected location: ${chalk.dim(daemonPath)}`);
      this.log('');
      this.log('Your installation may be corrupted. Try reinstalling:');
      this.log(`  ${chalk.cyan('npm install -g agor-live')}`);
      this.log('');
      this.exit(1);
    }

    // Check for pending migrations before starting daemon
    try {
      const db = createLocalDatabase();
      const migrationStatus = await checkMigrationStatus(db);

      if (migrationStatus.hasPending) {
        const dbPath = process.env.AGOR_DB_PATH || 'file:~/.agor/agor.db';
        const dbFilePath = extractDbFilePath(dbPath);

        this.log(chalk.red('✗ Database migrations required'));
        this.log('');
        this.log(`Pending migrations (${migrationStatus.pending.length}):`);
        for (const migration of migrationStatus.pending) {
          this.log(`  ${chalk.yellow('•')} ${migration}`);
        }
        this.log('');
        this.log(chalk.bold('⚠️  IMPORTANT: Backup your database before running migrations!'));
        this.log('');
        this.log('Backup command:');
        this.log(chalk.cyan(`  cp ${dbFilePath} ${dbFilePath}.backup-$(date +%s)`));
        this.log('');
        this.log('Then run migrations with:');
        this.log(`  ${chalk.cyan('agor db migrate')}`);
        this.log('');
        this.exit(1);
      }
    } catch (error) {
      // Rethrow if this is an exit error (so we don't continue starting daemon)
      if (error && typeof error === 'object' && 'oclif' in error) {
        throw error;
      }
      // Otherwise log warning and continue (for actual migration check errors)
      console.warn('Warning: Could not check migration status:', error);
    }

    // Check if already running
    const daemonUrl = await getDaemonUrl();
    const running = await isDaemonRunning(daemonUrl);

    if (running) {
      this.log(chalk.yellow('⚠ Daemon is already running'));
      this.log('');
      this.log('Check status with:');
      this.log(`  ${chalk.cyan('agor daemon status')}`);
      this.log('');
      this.exit(0);
    }

    try {
      if (flags.foreground) {
        // Foreground mode: run daemon inline (blocking)
        this.log(chalk.green('Starting daemon in foreground mode...'));
        this.log(chalk.dim(`URL: ${daemonUrl}`));
        this.log(chalk.dim('Press Ctrl+C to stop'));
        this.log('');

        const { spawn } = await import('node:child_process');

        // Start daemon as foreground process (inherits stdio)
        const child = spawn('node', [daemonPath], {
          stdio: 'inherit',
          env: {
            ...process.env,
            NODE_ENV: 'production',
          },
        });

        // Wait for child to exit
        await new Promise<void>((resolve, reject) => {
          child.on('exit', code => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Daemon exited with code ${code}`));
            }
          });

          child.on('error', reject);
        });
      } else {
        // Background mode: start detached daemon
        const pid = startDaemon(daemonPath);

        this.log(chalk.green('✓ Daemon started successfully'));
        this.log('');
        this.log(`  PID: ${chalk.cyan(String(pid))}`);
        this.log(`  URL: ${chalk.cyan(daemonUrl)}`);
        this.log('');
        this.log('View logs with:');
        this.log(`  ${chalk.cyan('agor daemon logs')}`);
        this.log('');

        // Wait for daemon to fully boot (including migrations if fresh install)
        // Try multiple times with exponential backoff
        let isRunning = false;
        const maxAttempts = 5;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const waitTime = 1000 * (attempt + 1); // 1s, 2s, 3s, 4s, 5s
          await new Promise(resolve => setTimeout(resolve, waitTime));

          isRunning = await isDaemonRunning(daemonUrl);
          if (isRunning) break;
        }

        if (!isRunning) {
          this.log(chalk.yellow('⚠ Daemon started but not responding'));
          this.log('');
          this.log('Check logs for errors:');
          this.log(`  ${chalk.cyan('agor daemon logs')}`);
          this.log('');
        }
      }
    } catch (error) {
      this.log(chalk.red('✗ Failed to start daemon'));
      this.log('');
      this.log(`Error: ${(error as Error).message}`);
      this.log('');
      this.exit(1);
    }
  }
}
