import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createExecutorSignalShutdown } from '../../src/signal-shutdown.js';

const descendant = process.argv.includes('descendant')
  ? spawn(
      process.execPath,
      [
        '-e',
        `
  process.on('SIGTERM', () => process.exit(0));
  process.on('disconnect', () => process.exit(0));
  process.send('ready');
  setInterval(() => {}, 1000);
`,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    )
  : undefined;
if (descendant) await once(descendant, 'message');

const shutdown = createExecutorSignalShutdown({
  shutdown: async () => {
    if (descendant) {
      const exited = once(descendant, 'exit');
      descendant.kill('SIGTERM');
      await exited;
      process.stdout.write('descendant-exited\n');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    process.stdout.write('cleanup-complete\n');
    process.stdout.write('report-complete\n');
  },
  exit: (code) => process.exit(code),
  warn: (message) => process.stderr.write(`${message}\n`),
});
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.send?.('ready');
setInterval(() => {}, 1_000);
