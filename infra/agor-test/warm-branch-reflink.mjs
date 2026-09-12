// Feed an operator-selected public Superset repo/user scope on stdin. This
// creates only a cache and temporary checkout, never an Agor branch record.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const { createBranchAsReflink } = await import(
  '/opt/agor-runtime/lib/node_modules/agor-live/dist/executor/git/index.js'
);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());
assert.match(input.remoteUrl, /^https:\/\/github\.com\/apache\/superset(?:\.git)?\/?$/);
assert.match(input.repoId, /^[a-f0-9-]{36}$/);
assert.match(input.userId, /^[a-f0-9-]{36}$/);
const config = JSON.parse(await readFile('/run/agor/dispatcher.json', 'utf8'));
const cacheRoot = config.branchReflinkRoot;
assert(cacheRoot && path.isAbsolute(cacheRoot));
await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
const scratch = await mkdtemp(path.join(cacheRoot, 'warm-'));
try {
  await createBranchAsReflink({
    remoteUrl: input.remoteUrl,
    referencePath: input.referencePath,
    cacheRoot,
    cacheScope: `${input.repoId}/${input.userId}`,
    targetPath: path.join(scratch, 'checkout'),
    ref: input.ref ?? 'master',
    refType: 'branch',
    newBranchName: 'agor-cache-warmup',
  });
  console.log('SUPERSET_BRANCH_CACHE_WARM');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
