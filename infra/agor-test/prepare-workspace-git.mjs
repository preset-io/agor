// Optional trusted-host prewarm for an inactive branch before enabling local Git.
// Run with the worker's IAM role, read-only config/source mounts and local storage.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire('/opt/agor-runtime/lib/node_modules/agor-live/package.json');
const runtime = '/opt/agor-runtime/lib/node_modules/agor-live/dist/executor/workspaces';
const { BranchWorkspaceCoordinator, hash } = await import(require.resolve('@agor/core/workspaces'));
const { connectWorkspaceAuthority } = await import(`${runtime}/connection.js`);
const { WorkerSqlAuthority } = await import(`${runtime}/sql-authority.js`);
const { S3WorkspaceBlobs } = await import(`${runtime}/s3-blobs.js`);
const { exportGitSeed, installGitSeed } = await import(`${runtime}/local-environment.js`);
const [configFile, tenantId, branchId, sourcePath] = process.argv.slice(2);
if (!/^[A-Za-z0-9_-]+$/.test(tenantId) || !/^[a-f0-9-]{36}$/.test(branchId))
  throw new Error('Invalid scope');
const config = JSON.parse(await readFile(configFile, 'utf8'));
const source = await realpath(sourcePath);
if (!source.startsWith(`${await realpath(config.sourceHome)}/`))
  throw new Error('Source outside Agor home');
const sql = await connectWorkspaceAuthority(config);
const seed = path.join(config.root, 'git-seeds', randomUUID());
try {
  const scope = { tenantId, branchId };
  const metadata = new WorkerSqlAuthority(sql, scope, 'git-seed');
  const c = new BranchWorkspaceCoordinator(
    scope,
    metadata,
    new S3WorkspaceBlobs(config.bucket, tenantId),
    {
      root: path.join(config.root, 'sdk', hash('git-seed')),
      host: `git-prewarm-${randomUUID()}`,
      clone: config.clone,
      leaseMs: 60000,
      toolLeaseMs: 3600000,
      maximumBytes: 20 * 1024 ** 3,
      maximumFiles: 250000,
      minimumFreeBytes: 5 * 1024 ** 3,
      minimumFreeInodes: 100000,
      maximumActiveTools: 2,
      maximumReceipts: 10000,
      exclude: [],
    }
  );
  await mkdir(seed, { recursive: true, mode: 0o700 });
  if (!(await metadata.read()).state) await exportGitSeed(source, seed);
  await c.materialise(seed);
  const id = randomUUID();
  const replica = await c.beginTool('seed', id, id);
  await c.completeTool(replica.ticket);
  await c.drain();
  const verification = path.join(seed, 'verify');
  await mkdir(verification);
  await installGitSeed(replica.workspace, verification, config.clone);
  const restored = JSON.parse(await readFile(path.join(replica.workspace, 'seed.json'), 'utf8'));
  if (restored.head)
    assert.equal(
      (await require('@agor/git').createGit(verification).git.revparse(['HEAD'])).trim(),
      restored.head
    );
  const warm = path.join(seed, 'verify-warm');
  await mkdir(warm);
  const started = performance.now();
  await installGitSeed(replica.workspace, warm, config.clone);
  const warmGitCloneMs = Math.round(performance.now() - started);
  if (restored.head)
    assert.notEqual(
      (await lstat(path.join(verification, '.git/index'))).ino,
      (await lstat(path.join(warm, '.git/index'))).ino
    );
  console.log(JSON.stringify({ branchId, gitHistoryReady: true, warmGitCloneMs }));
} finally {
  await sql.end();
  await rm(seed, { recursive: true, force: true });
}
