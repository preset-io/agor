/**
 * `agor open` - Open Agor UI in browser
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getUIUrl } from '../lib/context.js';
import { probeAgorDaemon } from '../lib/daemon-probe.js';
import {
  resolveConnectedDeploymentTarget,
  resolveLocalDeploymentTarget,
} from '../lib/deployment-target.js';

const execAsync = promisify(exec);

export default class Open extends Command {
  static description = 'Open the connected deployment in a browser';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  static flags = {
    local: Flags.boolean({ description: 'Open the locally configured deployment', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Open);
    const target = flags.local
      ? await resolveLocalDeploymentTarget()
      : await resolveConnectedDeploymentTarget();
    if (!target) {
      this.error('Not connected. Run agor login --url <daemon-url>.');
    }
    const daemonUrl = target.url;

    const probe = await probeAgorDaemon(daemonUrl);

    if (!probe.running) {
      this.log(chalk.red('✗ Connected daemon is not reachable'));
      this.log('');
      this.log(`Target: ${chalk.cyan(daemonUrl)}`);
      this.log('');
      this.exit(1);
    }
    if (probe.deploymentId !== target.deploymentId) {
      this.error(
        flags.local
          ? `The local daemon identity at ${daemonUrl} does not match config.yaml.`
          : `The daemon identity at ${daemonUrl} changed. Run agor login --url ${daemonUrl} again.`
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
