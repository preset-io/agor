import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgorConfig } from '@agor/core/client';
import * as yaml from 'js-yaml';

const DEFAULT_DAEMON_PORT = 3030;
const DEFAULT_DAEMON_HOST = 'localhost';

export function getDefaultConfig(): AgorConfig {
  return {
    daemon: {
      port: DEFAULT_DAEMON_PORT,
      host: DEFAULT_DAEMON_HOST,
      mcpEnabled: true,
    },
    ui: {
      port: 5173,
      host: 'localhost',
    },
    execution: {
      session_token_expiration_ms: 86400000,
      session_token_max_uses: 1,
      sync_unix_passwords: true,
    },
  };
}

export function loadConfigSync(): AgorConfig {
  const configPath = path.join(homedir(), '.agor', 'config.yaml');
  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = yaml.load(content) as AgorConfig;
    return config || {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return getDefaultConfig();
    }
    const detail = error instanceof Error ? error.message : String(error);
    // Agor's executor sandbox masks the daemon config with a `/dev/null` bind
    // mount, so reads from inside fail with EACCES rather than ENOENT. The
    // sandbox supplies DAEMON_URL precisely so this loader is never reached;
    // arriving here inside the sandbox means that injection is the thing that
    // broke. Explain that rather than fabricating a daemon address.
    if (process.env.AGOR_OUTER_SANDBOX === '1') {
      throw new Error(
        `DAEMON_URL is unset and ${configPath} is masked by Agor's executor sandbox. ` +
          'The sandbox provides DAEMON_URL — if it is missing, that is the bug. ' +
          `See context/explorations/executor-sandboxing.md. (underlying error: ${detail})`
      );
    }
    throw new Error(`Failed to load config: ${detail}`);
  }
}

export async function getDaemonUrl(): Promise<string> {
  if (process.env.DAEMON_URL) {
    return process.env.DAEMON_URL;
  }

  const config = loadConfigSync();
  const defaults = getDefaultConfig();
  const envPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : undefined;
  const port = envPort || config.daemon?.port || defaults.daemon?.port || DEFAULT_DAEMON_PORT;
  const host = config.daemon?.host || defaults.daemon?.host || DEFAULT_DAEMON_HOST;
  return `http://${host}:${port}`;
}
