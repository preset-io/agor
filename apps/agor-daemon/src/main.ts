/**
 * Daemon entrypoint — starts the server.
 *
 * index.ts is a pure library that exports startDaemon().
 * This file calls it for direct execution (pnpm dev, node dist/main.js).
 */

import { startDaemon } from './index.js';

startDaemon().catch((error) => {
  console.error('Failed to start daemon:', error);
  process.exit(1);
});
