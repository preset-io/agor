import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkDaemonFilesystemBoundaries } from './check-daemon-filesystem-boundaries.mjs';

function run(files, registry = [], options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agor-fs-boundary-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    writeFileSync(join(root, 'exceptions.json'), JSON.stringify(registry));
    return checkDaemonFilesystemBoundaries({
      root,
      entry: 'apps/agor-daemon/src/index.ts',
      registryPath: 'exceptions.json',
      today: '2026-07-28',
      ...options,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const base = {
  id: 'TEST-A-001',
  class: 'A',
  file: 'apps/agor-daemon/src/index.ts',
  import: 'node:fs',
  symbol: 'readFileSync',
  local: 'read',
  operation: 'call:read@load#1',
  owner: 'daemon host operator',
  boundary: 'local config',
  rationale: 'Reads operator configuration.',
  reviewTarget: null,
  reviewDate: null,
};

test('detects exact calls through named aliases, namespace/default imports, require, and dynamic import', () => {
  const errors = run({
    'apps/agor-daemon/src/index.ts': `import {readFileSync as read} from 'node:fs'; import fs from 'node:fs'; const p=require('node:fs/promises'); async function load(){read('a');fs.statSync('a');p.rm('a');const {writeFile:w}=await import('node:fs/promises');w('a','x');}`,
  });
  for (const name of [
    'call:read@load#1',
    'call:fs.statSync@load#1',
    'call:p.rm@load#1',
    'call:w@load#1',
  ])
    assert.match(errors.join('\n'), new RegExp(name.replaceAll('.', '\\.')));
});
test('non-literal import and require require review', () => {
  const errors = run({
    'apps/agor-daemon/src/index.ts': `const name='node:fs'; async function load(){await import(name);require(name)}`,
  });
  assert.match(errors.join('\n'), /review:dynamic-import@load/);
  assert.match(errors.join('\n'), /review:require@load/);
});
test('tracks simple assignments and destructuring from privileged bindings', () => {
  const errors = run({
    'apps/agor-daemon/src/index.ts': `import fs from 'node:fs'; async function load(){const read=fs.readFileSync;read('a');const {rm}=fs.promises;await rm('a')}`,
  });
  assert.match(errors.join('\n'), /node:fs#readFileSync capability call:read@load#1/);
  assert.match(errors.join('\n'), /node:fs#rm capability call:rm@load#1/);
});
test('numbers repeated non-literal imports and requires independently', () => {
  const errors = run({
    'apps/agor-daemon/src/index.ts': `async function load(a,b){await import(a);await import(b);require(a);require(b)}`,
  }).join('\n');
  assert.match(errors, /review:dynamic-import@load#1/);
  assert.match(errors, /review:dynamic-import@load#2/);
  assert.match(errors, /review:require@load#1/);
  assert.match(errors, /review:require@load#2/);
});
test('follows a workspace package and barrel into shared filesystem code', () => {
  const errors = run({
    'apps/agor-daemon/src/index.ts': `import {load} from '@fixture/shared'; load();`,
    'packages/shared/package.json': JSON.stringify({
      name: '@fixture/shared',
      exports: { '.': { source: './src/index.ts' } },
    }),
    'packages/shared/src/index.ts': `export {load} from './load.js';`,
    'packages/shared/src/load.ts': `import {readFileSync} from 'node:fs'; export function load(){return readFileSync('x')}`,
  });
  assert.match(errors.join('\n'), /packages\/shared\/src\/load\.ts.*readFileSync/);
});
test('adapter placement is not trusted and path.posix remains pure', () => {
  const errors = run({
    'apps/agor-daemon/src/index.ts': `import './host/local/config.js'; import path from 'node:path'; path.posix.join('a','b');`,
    'apps/agor-daemon/src/host/local/config.ts': `import {readFileSync as read} from 'node:fs'; export function load(){return read('x')}`,
  });
  assert.match(errors.join('\n'), /host\/local\/config\.ts/);
  assert.doesNotMatch(errors.join('\n'), /node:path/);
});
test('one exact declaration does not permit a second call', () => {
  const files = {
    'apps/agor-daemon/src/index.ts': `import {readFileSync as read} from 'node:fs'; function load(){read('a');read('b')}`,
  };
  const errors = run(files, [base]);
  assert.doesNotMatch(errors.join('\n'), /call:read@load#1/);
  assert.match(errors.join('\n'), /call:read@load#2/);
});
test('capability manifest covers indirect APIs and child process callsites', () => {
  const errors = run({
    'apps/agor-daemon/src/index.ts': `import {execFile as run} from 'node:child_process'; import multer from 'multer'; function boot(){run('rm',['x']);multer.diskStorage({})}`,
  });
  assert.match(errors.join('\n'), /call:run@boot/);
  assert.match(errors.join('\n'), /multer#diskStorage/);
});
test('validates schema, dates, paths, IDs, exact tuples, stale entries, and class null policy', () => {
  const duplicate = { ...base, id: 'TEST-A-002' };
  const errors = run({ 'apps/agor-daemon/src/index.ts': 'export {}' }, [
    { ...base, id: 'same', file: '../escape.ts', symbol: '*', reviewDate: '2026-02-30' },
    { ...duplicate, id: 'same', class: 'B', reviewTarget: null, reviewDate: null },
    { ...duplicate, id: 'TEST-A-003' },
  ]);
  const text = errors.join('\n');
  for (const wanted of [
    'duplicate stable ID',
    'malformed repository-relative',
    'contain no wildcard',
    'invalid reviewDate',
    'duplicate capability tuple',
    'class B requires',
    'stale capability',
  ])
    assert.match(text, new RegExp(wanted));
});
test('rejects expired transitional entries but permits indefinite exact A capabilities', () => {
  assert.deepEqual(
    run(
      {
        'apps/agor-daemon/src/index.ts': `import {readFileSync as read} from 'node:fs'; function load(){read('a')}`,
      },
      [base]
    ),
    []
  );
  const errors = run({ 'apps/agor-daemon/src/index.ts': 'export {}' }, [
    { ...base, class: 'C', reviewTarget: 'move it', reviewDate: '2026-07-01' },
  ]);
  assert.match(errors.join('\n'), /expired/);
});
