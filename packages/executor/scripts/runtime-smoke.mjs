import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const result = spawnSync(process.execPath, ['dist/cli.js'], {
  cwd: packageDirectory,
  encoding: 'utf8',
  env: {
    ...process.env,
    NODE_NO_WARNINGS: '1',
  },
});

assert.equal(
  result.status,
  1,
  `Expected the executor CLI without arguments to exit with status 1.\n${result.stderr}`
);
assert.match(
  result.stderr,
  /^(?:<3>)?Usage: agor-executor \[OPTIONS\]$/m,
  `Executor CLI did not reach argument handling after Node loaded the compiled module graph.\n${result.stderr}`
);
