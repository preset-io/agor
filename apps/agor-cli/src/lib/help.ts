/**
 * Custom Help Class
 *
 * Extends oclif's default help to show our hero banner and daemon status
 */

import { access } from 'node:fs/promises';
import {
  getConfigPath,
  loadConfig,
  requireDeploymentId,
  resolveDaemonUrl,
} from '@agor/core/config';
import { Help } from '@oclif/core';
import chalk from 'chalk';
import { loadToken } from './auth.js';
import { getBanner } from './banner.js';
import { probeAgorDaemon } from './daemon-probe.js';

export default class CustomHelp extends Help {
  async showRootHelp(): Promise<void> {
    // Show hero banner first
    this.log(getBanner());

    const auth = await loadToken();
    let local: { url: string; deploymentId: string } | null = null;
    let localError: string | null = null;
    try {
      const hasLocalConfig = await access(getConfigPath()).then(
        () => true,
        () => false
      );
      if (hasLocalConfig) {
        const config = await loadConfig();
        local = { url: resolveDaemonUrl(config), deploymentId: requireDeploymentId(config) };
      }
    } catch (error) {
      localError = error instanceof Error ? error.message : String(error);
    }

    this.log('');
    if (auth) {
      const probe = await probeAgorDaemon(auth.target.url);
      const identityMatches = probe.deploymentId === auth.target.deploymentId;
      this.log(
        `  ${identityMatches ? chalk.green('●') : chalk.red('●')} Connected: ${chalk.bold(auth.target.url)}`
      );
      this.log(`    Deployment: ${auth.target.deploymentId}`);
      this.log(`    User: ${auth.user.email}`);
      if (!probe.running) this.log(`    ${chalk.red('Unreachable')}`);
      else if (!identityMatches) this.log(`    ${chalk.red('Identity mismatch — login required')}`);
    } else {
      this.log(`  ${chalk.yellow('●')} Connected: ${chalk.yellow('Logged out')}`);
    }

    if (local) {
      const probe = await probeAgorDaemon(local.url);
      const locked = auth && auth.target.deploymentId !== local.deploymentId;
      this.log(
        `  ${probe.running ? chalk.green('●') : chalk.red('●')} Local: ${probe.running ? chalk.green('Running') : chalk.red('Stopped')} ${chalk.dim(`(${local.url})`)}`
      );
      this.log(`    Deployment: ${local.deploymentId}`);
      if (locked) this.log(`    ${chalk.yellow('Locked while logged into another deployment')}`);
    } else if (localError) {
      this.log(`  ${chalk.red('●')} Local: ${chalk.red('Invalid configuration')}`);
      this.log(`    ${chalk.dim(localError)}`);
    } else {
      this.log(`  ${chalk.dim('●')} Local: ${chalk.dim('Not installed')}`);
    }
    this.log(''); // Empty line

    // Then show standard help
    return super.showRootHelp();
  }
}
