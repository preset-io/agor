// Run on an idle worker with its controller stopped. Explicit names prevent
// resurrecting intentional deletions; existing files are never overwritten.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chown, lchown, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ownWorkspaceSource } from './workspace-ownership.mjs';

const require = createRequire('/opt/agor-runtime/lib/node_modules/agor-live/package.json');
const runtime = '/opt/agor-runtime/lib/node_modules/agor-live/dist/executor/workspaces';
const { BranchWorkspaceCoordinator } = await import(require.resolve('@agor/core/workspaces'));
const { connectWorkspaceAuthority } = await import(`${runtime}/connection.js`);
const { WorkerSqlAuthority } = await import(`${runtime}/sql-authority.js`);
const { S3WorkspaceBlobs } = await import(`${runtime}/s3-blobs.js`);
const { restoreMissingRepositoryConfiguration } = await import(`${runtime}/local-environment.js`);
const [configFile, tenantId, branchId, sessionId, ...names] = process.argv.slice(2);
assert(/^[A-Za-z0-9_-]+$/.test(tenantId));
for (const id of [branchId, sessionId]) assert(/^[a-f0-9-]{36}$/.test(id));
assert(names.length > 0);
const config = JSON.parse(await readFile(configFile, 'utf8'));
const sql = await connectWorkspaceAuthority(config);
let renewal;
let coordinator;
let ticket;
try {
  const scope = { tenantId, branchId };
  const metadata = new WorkerSqlAuthority(sql, scope, 'code');
  const snapshot = await metadata.read();
  assert(
    snapshot.state &&
      (Object.keys(snapshot.state.active).length === 0 ||
        snapshot.state.leaseUntil <= snapshot.now),
    'Active workspace tools prevent repair'
  );
  const c = new BranchWorkspaceCoordinator(
    scope,
    metadata,
    new S3WorkspaceBlobs(config.bucket, tenantId),
    {
      root: config.root,
      host: `${config.origin}#repair-${randomUUID()}`,
      clone: config.clone,
      leaseMs: 60000,
      toolLeaseMs: 3600000,
      maximumBytes: 20 * 1024 ** 3,
      maximumFiles: 250000,
      minimumFreeBytes: 5 * 1024 ** 3,
      minimumFreeInodes: 100000,
      maximumActiveTools: 1,
      maximumReceipts: 10000,
      exclude: [],
    }
  );
  coordinator = c;
  await c.materialise();
  let leaseError;
  renewal = setInterval(() => {
    void c.renew().catch((error) => {
      leaseError ??= error;
    });
  }, 10000);
  const id = randomUUID();
  const tool = await c.beginTool(sessionId, id, id);
  ticket = tool.ticket;
  const restored = await restoreMissingRepositoryConfiguration(tool.workspace, names);
  for (const name of restored) {
    let filename = path.join(tool.workspace, name);
    await lchown(filename, 1000, 1000);
    filename = path.dirname(filename);
    while (filename !== tool.workspace) {
      await chown(filename, 1000, 1000);
      filename = path.dirname(filename);
    }
  }
  if (leaseError) throw leaseError;
  const outcome = await c.completeTool(tool.ticket);
  assert.equal(outcome.status, 'committed');
  ticket = undefined;
  await ownWorkspaceSource(tool.workspace, (await metadata.read()).state.tree);
  await c.drain();
  const { git } = require('@agor/git').createGit(tool.workspace);
  const status = await git.status();
  console.log(JSON.stringify({ restored, outcome, remainingDeletedPaths: status.deleted }));
} finally {
  if (ticket) {
    await coordinator.abortTool(ticket).catch(() => {});
    await coordinator.drain().catch(() => {});
  }
  clearInterval(renewal);
  await sql.end();
}
