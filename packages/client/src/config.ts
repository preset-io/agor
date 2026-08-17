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
  let content: string;
  // Read and parse are caught separately: only a read failure can be the
  // sandbox mask, and blaming it for malformed YAML in a file we just read
  // successfully would send the reader after the wrong thing.
  try {
    content = readFileSync(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return getDefaultConfig();
    }
    const detail = error instanceof Error ? error.message : String(error);
    // Agor's executor sandbox masks the daemon config with a `/dev/null` bind
    // mount, so reads from inside fail with EACCES rather than ENOENT.
    // `getDaemonUrl()` only consults this loader when DAEMON_URL is unset, and
    // the sandbox is meant to supply it — so reaching here inside the sandbox
    // points at that injection, not at the config file.
    if (process.env.AGOR_OUTER_SANDBOX === '1') {
      throw new Error(
        `${configPath} is masked by Agor's executor sandbox and is intentionally out of reach. ` +
          'Inside the sandbox the daemon address comes from DAEMON_URL; if that is unset, ' +
          `that is the bug. See context/explorations/executor-sandboxing.md. (underlying error: ${detail})`
      );
    }
    throw new Error(`Failed to load config: ${detail}`);
  }

  try {
    const config = yaml.load(content) as AgorConfig;
    return config || {};
  } catch (error) {
    throw new Error(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
    );
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
