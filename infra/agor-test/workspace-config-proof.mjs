// Real RDS/S3 configuration round trip. Run initial and restore on different hosts.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire('/opt/agor-runtime/lib/node_modules/agor-live/package.json');
const runtime = '/opt/agor-runtime/lib/node_modules/agor-live/dist/executor/workspaces';
const { BranchWorkspaceCoordinator } = await import(require.resolve('@agor/core/workspaces'));
const { connectWorkspaceAuthority } = await import(`${runtime}/connection.js`);
const { WorkerSqlAuthority } = await import(`${runtime}/sql-authority.js`);
const { S3WorkspaceBlobs } = await import(`${runtime}/s3-blobs.js`);
const [configFile, phase, branchId] = process.argv.slice(2);
assert(['initial', 'restore'].includes(phase));
assert(/^[a-f0-9-]{36}$/.test(branchId));
const config = JSON.parse(await readFile(configFile, 'utf8'));
const root = path.join(config.root, `config-proof-${branchId}`);
const source = path.join(root, 'source');
const tracked = [
  'frontend/.npmrc',
  'docker/.env',
  '.claude/settings.json',
  'docs/.claude/instructions.md',
];
const sql = await connectWorkspaceAuthority(config);
try {
  const scope = { tenantId: 'architecture-proof', branchId };
  const metadata = new WorkerSqlAuthority(sql, scope, 'code');
  const c = new BranchWorkspaceCoordinator(
    scope,
    metadata,
    new S3WorkspaceBlobs(config.bucket, scope.tenantId),
    {
      root,
      host: `config-proof-${randomUUID()}`,
      clone: config.clone,
      leaseMs: 60000,
      toolLeaseMs: 60000,
      maximumBytes: 1000000,
      maximumFiles: 1000,
      minimumFreeBytes: 0,
      minimumFreeInodes: 0,
      maximumActiveTools: 1,
      maximumReceipts: 100,
      exclude: [],
    }
  );
  if (phase === 'initial') {
    assert.equal((await metadata.read()).state, null);
    await mkdir(source, { recursive: true });
    const { git } = require('@agor/git').createGit(source);
    await git.init();
    for (const name of tracked) {
      await mkdir(path.dirname(path.join(source, name)), { recursive: true });
      await writeFile(path.join(source, name), 'tracked configuration');
    }
    await git.add(tracked);
    await writeFile(path.join(source, '.npmrc'), 'private token');
    await writeFile(path.join(source, '.claude/settings.local.json'), 'private local settings');
    await c.materialise(source);
  } else await c.restore();
  const id = randomUUID();
  const tool = await c.beginTool('proof-session', id, id);
  for (const name of tracked)
    assert.equal(await readFile(path.join(tool.workspace, name), 'utf8'), 'tracked configuration');
  for (const name of ['.npmrc', '.claude/settings.local.json'])
    await assert.rejects(readFile(path.join(tool.workspace, name)), { code: 'ENOENT' });
  const before = (await metadata.read()).state.revision;
  assert.equal((await c.completeTool(tool.ticket)).status, 'committed');
  assert.equal((await metadata.read()).state.revision, before);
  await c.drain();
  console.log(
    JSON.stringify({
      phase,
      branchId,
      result: 'PASS',
      trackedConfiguration: tracked.length,
      privateFilesExcluded: true,
      gitlessReplicaPreservedConfiguration: true,
    })
  );
} finally {
  await sql.end();
  await rm(root, { recursive: true, force: true });
}
