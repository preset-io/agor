/**
 * `agor open` - Open Agor UI in browser
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { isDaemonRunning } from '@agor-live/client';
import { getDaemonUrl } from '@agor-live/client/config';
import { Command } from '@oclif/core';
import chalk from 'chalk';
import { getUIUrl, isCodespaces } from '../lib/context.js';

const execAsync = promisify(exec);

export default class Open extends Command {
  static description = 'Open Agor UI in browser';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    // Get daemon URL for health check
    const daemonUrl = await getDaemonUrl();

    // Check if daemon is running
    const running = await isDaemonRunning(daemonUrl);

    if (!running) {
      this.log(chalk.red('✗ Daemon is not running'));
      this.log('');
      this.log('Start the daemon first:');
      this.log(`  ${chalk.cyan('agor daemon start')}`);
      this.log('');
      this.exit(1);
    }

    // Get UI URL (context-aware: dev/prod/codespaces)
    const uiUrl = getUIUrl();

    // In Codespaces: can't open browser, just print URL
    if (isCodespaces()) {
      this.log(chalk.green('✓ Agor UI is ready'));
      this.log('');
      this.log('Open this URL in your browser:');
      this.log(`  ${chalk.cyan(uiUrl)}`);
      this.log('');
      this.log(chalk.dim('(GitHub Codespaces will automatically forward the port)'));
      this.log('');
      return;
    }

    // Local environment: try to open browser
    try {
      this.log(chalk.green('Opening Agor UI in browser...'));
      this.log(chalk.dim(`URL: ${uiUrl}`));
      this.log('');

      // Platform-specific open command
      const platform = process.platform;
      let command: string;

      if (platform === 'darwin') {
        command = `open "${uiUrl}"`;
      } else if (platform === 'win32') {
        command = `start "" "${uiUrl}"`;
      } else {
        // Linux/Unix
        command = `xdg-open "${uiUrl}"`;
      }

      await execAsync(command);
      this.log(chalk.green('✓ Browser opened'));
    } catch (_error) {
      this.log(chalk.yellow('⚠ Could not open browser automatically'));
      this.log('');
      this.log('Visit this URL manually:');
      this.log(`  ${chalk.cyan(uiUrl)}`);
      this.log('');
    }
  }
}
