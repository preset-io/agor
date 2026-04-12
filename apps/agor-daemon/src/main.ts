/**
 * Daemon entrypoint — starts the server.
 *
 * index.ts is a pure library that exports startDaemon().
 * This file calls it for direct execution (pnpm dev, node dist/main.js).
 *
 * Supports AGOR_CONFIG_PATH env var for config file override
 * (set by `agor daemon start --config ...`).
 */

import { startDaemon } from './index.js';

const configPath = process.env.AGOR_CONFIG_PATH || undefined;

startDaemon(configPath ? { configPath } : undefined).catch((error) => {
  console.error('Failed to start daemon:', error);
  process.exit(1);
});
