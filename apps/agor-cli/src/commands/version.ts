/** `agor version` - Print the selected daemon's build identity. */

import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  resolveConnectedDeploymentTarget,
  resolveLocalDeploymentTarget,
} from '../lib/deployment-target.js';

interface HealthBuildInfo {
  buildSha?: string;
  builtAt?: string | null;
  deploymentId?: string;
  version?: string;
}

export default class Version extends Command {
  static description = 'Show the connected daemon version';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --local',
  ];

  static flags = {
    local: Flags.boolean({ description: 'Inspect the locally configured daemon', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Version);
    const target = flags.local
      ? await resolveLocalDeploymentTarget()
      : await resolveConnectedDeploymentTarget();
    if (!target) {
      this.error('Not connected. Run agor login --url <daemon-url>.');
    }

    const info = await fetchHealth(target.url);
    if (!info) this.error(`The daemon at ${target.url} is not reachable.`);
    if (info.deploymentId !== target.deploymentId) {
      this.error(
        flags.local
          ? `The local daemon identity at ${target.url} does not match config.yaml.`
          : `The daemon identity at ${target.url} changed. Run agor login --url ${target.url} again.`
      );
    }

    this.log(`${chalk.bold('Daemon:')} ${chalk.cyan(info.version ?? 'unknown version')}`);
    if (info.buildSha) this.log(`  build: ${chalk.dim(info.buildSha)}`);
    if (info.builtAt) this.log(`  built: ${chalk.dim(info.builtAt)}`);
    this.log(`  deployment: ${chalk.dim(target.deploymentId)}`);
    this.log(`  source: ${chalk.dim(`/health @ ${target.url}`)}`);
  }
}

async function fetchHealth(daemonUrl: string): Promise<HealthBuildInfo | null> {
  try {
    const response = await fetch(`${daemonUrl}/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const body = (await response.json()) as HealthBuildInfo & { service?: string };
    return body.service === 'agor-daemon' ? body : null;
  } catch {
    return null;
  }
}
