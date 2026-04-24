/**
 * `agor version` - Print daemon build identity
 *
 * Reports the build SHA so operators can verify which deploy is live.
 * Resolution order mirrors the daemon's loadBuildInfo():
 *   1. /health (when the daemon is reachable)
 *   2. <daemon-dist>/.build-info file (offline fallback)
 *   3. 'dev' (source-mode contributors)
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDaemonUrl } from '@agor-live/client/config';
import { Command } from '@oclif/core';
import chalk from 'chalk';

interface HealthBuildInfo {
  buildSha?: string;
  builtAt?: string | null;
  version?: string;
}

export default class Version extends Command {
  static description = 'Show daemon build SHA + CLI package version';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    // 1. Try the running daemon first — this is what the UI sees.
    const daemonUrl = await getDaemonUrl();
    const liveInfo = await fetchHealth(daemonUrl);
    if (liveInfo?.buildSha) {
      this.log(`${chalk.bold('Daemon (live):')} ${chalk.cyan(liveInfo.buildSha)}`);
      if (liveInfo.builtAt) this.log(`  built: ${chalk.dim(liveInfo.builtAt)}`);
      if (liveInfo.version) this.log(`  pkg version: ${chalk.dim(liveInfo.version)}`);
      this.log(`  source: ${chalk.dim(`/health @ ${daemonUrl}`)}`);
      return;
    }

    // 2. Daemon not reachable — fall back to the .build-info file. This works
    //    in agor-live installs even when the daemon is stopped.
    const fileInfo = await readBuildInfoFile();
    if (fileInfo?.sha) {
      this.log(`${chalk.bold('Daemon (file):')} ${chalk.cyan(fileInfo.sha)}`);
      if (fileInfo.builtAt) this.log(`  built: ${chalk.dim(fileInfo.builtAt)}`);
      this.log(`  source: ${chalk.dim('<daemon-dist>/.build-info (daemon not running)')}`);
      return;
    }

    // 3. No daemon, no file — this is a source checkout that hasn't been built.
    this.log(
      `${chalk.bold('Daemon:')} ${chalk.yellow('dev')} ${chalk.dim('(no .build-info; daemon offline)')}`
    );
  }
}

async function fetchHealth(daemonUrl: string): Promise<HealthBuildInfo | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`${daemonUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return (await res.json()) as HealthBuildInfo;
  } catch {
    return null;
  }
}

async function readBuildInfoFile(): Promise<{ sha?: string; builtAt?: string | null } | null> {
  // Look next to the CLI bundle. In agor-live, `cli/` and `daemon/` are
  // siblings under dist/, so the file lives at ../daemon/.build-info.
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(cliDir, '../daemon/.build-info'),
    join(cliDir, '../../daemon/.build-info'),
  ];
  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw) as { sha?: string; builtAt?: string | null };
      if (parsed.sha) return parsed;
    } catch {
      // try next
    }
  }
  return null;
}
