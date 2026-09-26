/**
 * `agor open` - Open Agor UI in browser
 */

import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { openInBrowser } from '../lib/browser.js';
import { getUIUrl } from '../lib/context.js';
import { probeAgorDaemon } from '../lib/daemon-probe.js';
import {
  resolveConnectedDeploymentTarget,
  resolveLocalDeploymentTarget,
} from '../lib/deployment-target.js';

export default class Open extends Command {
  static description = 'Open the local deployment in a browser';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --remote',
  ];

  static flags = {
    local: Flags.boolean({
      description: 'Open the locally configured deployment (default)',
      default: false,
      exclusive: ['remote'],
    }),
    remote: Flags.boolean({
      description: 'Open the connected remote deployment',
      default: false,
      exclusive: ['local'],
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Open);
    const target = flags.remote
      ? await resolveConnectedDeploymentTarget()
      : await resolveLocalDeploymentTarget();
    if (!target) {
      this.error('Not connected. Run agor login --url <daemon-url>.');
    }
    const isLocalTarget = target.source === 'local';
    const daemonUrl = target.url;

    const probe = await probeAgorDaemon(daemonUrl);

    if (!probe.running) {
      this.log(
        chalk.red(
          isLocalTarget ? '✗ Local daemon is not reachable' : '✗ Connected daemon is not reachable'
        )
      );
      this.log('');
      this.log(`Target: ${chalk.cyan(daemonUrl)}`);
      this.log('');
      this.exit(1);
    }
    if (target.pinDeployment && probe.deploymentId !== target.deploymentId) {
      this.error(
        isLocalTarget
          ? `The local daemon identity at ${daemonUrl} does not match config.yaml.`
          : `The daemon identity at ${daemonUrl} changed. Run agor login --url ${daemonUrl} again.`
      );
    }

    let localDevelopmentTarget = isLocalTarget;
    if (!localDevelopmentTarget) {
      try {
        const localTarget = await resolveLocalDeploymentTarget();
        localDevelopmentTarget =
          localTarget.deploymentId === target.deploymentId && localTarget.url === target.url;
      } catch {
        // No valid local deployment; the connected target remains unambiguously remote.
      }
    }
    const uiUrl = getUIUrl(daemonUrl, localDevelopmentTarget);

    this.log(chalk.green('Opening Agor UI in browser...'));
    this.log(chalk.dim(`URL: ${uiUrl}`));
    this.log('');

    if (await openInBrowser(uiUrl)) {
      this.log(chalk.green('✓ Browser opened'));
    } else {
      this.log(chalk.yellow('⚠ Could not open browser automatically'));
      this.log('');
      this.log('Visit this URL manually:');
      this.log(`  ${chalk.cyan(uiUrl)}`);
      this.log('');
    }
  }
}
