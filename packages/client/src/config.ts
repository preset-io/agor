import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgorConfig } from '@agor/core/client';
import yaml from 'js-yaml';

const DEFAULT_DAEMON_PORT = 3030;
const DEFAULT_DAEMON_HOST = 'localhost';

export function getDefaultConfig(): AgorConfig {
  return {
    defaults: {
      board: 'main',
      agent: 'claude-code',
    },
    display: {
      tableStyle: 'unicode',
      colorOutput: true,
      shortIdLength: 8,
    },
    daemon: {
      port: DEFAULT_DAEMON_PORT,
      host: DEFAULT_DAEMON_HOST,
      allowAnonymous: true,
      requireAuth: false,
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
