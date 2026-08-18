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
import {
  CONNECTED_DEPLOYMENT_COMMANDS,
  LOCAL_DEPLOYMENT_COMMANDS,
  type RootCommandEntry,
} from './command-groups.js';
import { probeAgorDaemon } from './daemon-probe.js';
import { resolveConnectedDeploymentTarget } from './deployment-target.js';

export default class CustomHelp extends Help {
  async showRootHelp(): Promise<void> {
    // Show hero banner first
    this.log(getBanner());

    const auth = await loadToken();
    let connectedTarget: Awaited<ReturnType<typeof resolveConnectedDeploymentTarget>> = null;
    let connectionError: string | null = null;
    try {
      connectedTarget = await resolveConnectedDeploymentTarget();
    } catch (error) {
      connectionError = error instanceof Error ? error.message : String(error);
    }
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
    if (connectedTarget) {
      const probe = await probeAgorDaemon(connectedTarget.url);
      const identityMatches = probe.deploymentId === connectedTarget.deploymentId;
      this.log(
        `  ${identityMatches ? chalk.green('●') : chalk.red('●')} Connected: ${chalk.bold(connectedTarget.url)}`
      );
      this.log(`    Deployment: ${connectedTarget.deploymentId}`);
      this.log(
        connectedTarget.source === 'environment'
          ? '    Authentication: API key environment'
          : `    User: ${auth?.user.email ?? 'unknown'}`
      );
      if (!probe.running) this.log(`    ${chalk.red('Unreachable')}`);
      else if (!identityMatches) this.log(`    ${chalk.red('Identity mismatch — login required')}`);
    } else if (connectionError) {
      this.log(`  ${chalk.red('●')} Connected: ${chalk.red('Invalid environment')}`);
      this.log(`    ${chalk.dim(connectionError)}`);
    } else {
      this.log(`  ${chalk.yellow('●')} Connected: ${chalk.yellow('Logged out')}`);
    }

    if (local) {
      const probe = await probeAgorDaemon(local.url);
      const locked = connectedTarget && connectedTarget.deploymentId !== local.deploymentId;
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

    this.log(this.formatRoot());
    this.log('');
    this.log(this.formatDeploymentGroup('LOCAL DEPLOYMENT', LOCAL_DEPLOYMENT_COMMANDS));
    this.log('');
    this.log(this.formatDeploymentGroup('CONNECTED DEPLOYMENT', CONNECTED_DEPLOYMENT_COMMANDS));
    this.log('');
  }

  private formatDeploymentGroup(title: string, entries: readonly RootCommandEntry[]) {
    const width = Math.max(...entries.map(([name]) => name.length));
    return [
      chalk.bold(title),
      ...entries.map(
        ([name, description]) => `  ${chalk.cyan(name.padEnd(width))}  ${chalk.dim(description)}`
      ),
    ].join('\n');
  }
}
