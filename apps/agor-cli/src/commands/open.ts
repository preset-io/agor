/**
 * `agor open` - Open Agor UI in browser
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Command } from '@oclif/core';
import chalk from 'chalk';
import { loadToken } from '../lib/auth.js';
import { getUIUrl } from '../lib/context.js';
import { probeAgorDaemon } from '../lib/daemon-probe.js';

const execAsync = promisify(exec);

export default class Open extends Command {
  static description = 'Open Agor UI in browser';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    const auth = await loadToken();
    if (!auth) {
      this.error('Not connected. Run agor login --url <daemon-url>.');
    }
    const daemonUrl = auth.target.url;

    const probe = await probeAgorDaemon(daemonUrl);

    if (!probe.running) {
      this.log(chalk.red('✗ Connected daemon is not reachable'));
      this.log('');
      this.log(`Target: ${chalk.cyan(daemonUrl)}`);
      this.log('');
      this.exit(1);
    }
    if (probe.deploymentId !== auth.target.deploymentId) {
      this.error(
        `The daemon identity at ${daemonUrl} changed. Run agor login --url ${daemonUrl} again.`
      );
    }

    // Get UI URL (context-aware: dev/prod)
    const uiUrl = getUIUrl(daemonUrl);

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
