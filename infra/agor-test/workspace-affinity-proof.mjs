// Run seed on one EC2 worker and restore on another with the same isolated scope.
// Uses real PostgreSQL/S3, no model credentials and no production session directories.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire('/opt/agor-runtime/lib/node_modules/agor-live/package.json');
const runtime = '/opt/agor-runtime/lib/node_modules/agor-live/dist/executor/workspaces';
const { BranchWorkspaceCoordinator } = await import(require.resolve('@agor/core/workspaces'));
const { connectWorkspaceAuthority } = await import(`${runtime}/connection.js`);
const { WorkerSqlAuthority } = await import(`${runtime}/sql-authority.js`);
const { S3WorkspaceBlobs } = await import(`${runtime}/s3-blobs.js`);
const { reclaimWorkspace } = await import(`${runtime}/reclamation.js`);
const { restoreReplicas } = await import(`${runtime}/recovery.js`);
const [phase, configPath, scopePath] = process.argv.slice(2);
assert(['seed', 'restore'].includes(phase));
const config = JSON.parse(await readFile(configPath, 'utf8'));
const scope = JSON.parse(await readFile(scopePath, 'utf8'));
assert(/^affinity-proof-[a-f0-9]{16}$/.test(scope.tenantId));
assert(/^[a-f0-9-]{36}$/.test(scope.branchId));
const root = `/var/lib/agor-affinity-proof/${scope.tenantId}`;
const session = 'proof-session';
const sql = await connectWorkspaceAuthority(config);
const metadata = new WorkerSqlAuthority(sql, scope);
const blobs = new S3WorkspaceBlobs(config.bucket, scope.tenantId);
const coordinator = new BranchWorkspaceCoordinator(scope, metadata, blobs, {
  root,
  host: `${config.origin}#affinity-proof-${phase}`,
  clone: 'reflink',
  leaseMs: 60000,
  toolLeaseMs: 60000,
  maximumBytes: 10 * 1024 ** 2,
  maximumFiles: 10000,
  minimumFreeBytes: 1024 ** 3,
  minimumFreeInodes: 1000,
  maximumActiveTools: 4,
  maximumReceipts: 100,
  exclude: [],
});
const started = performance.now();
try {
  if (phase === 'seed') {
    assert.equal((await metadata.read()).state, null, 'Use a fresh proof scope');
    const source = path.join(root, 'source');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'source.txt'), 'durable source');
    await coordinator.materialise(source);
    const tool = await coordinator.beginTool(session, 'seed', 'seed');
    const git = require('simple-git')(tool.workspace);
    await git.init();
    await git.addConfig('user.name', 'Affinity proof');
    await git.addConfig('user.email', 'proof@agor.test');
    await git.add('source.txt');
    await git.commit('Unpublished local commit');
    await writeFile(path.join(tool.workspace, 'expected-head.txt'), await git.revparse(['HEAD']));
    await mkdir(path.join(tool.workspace, 'node_modules/proof-dependency'), { recursive: true });
    await writeFile(
      path.join(tool.workspace, 'node_modules/proof-dependency/index.js'),
      'warm dependency'
    );
    const home = path.join(coordinator.directory, 'replicas', session, 'local-home/.local');
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, 'proof'), 'private home');
    assert.equal((await coordinator.completeTool(tool.ticket)).status, 'committed');
    await reclaimWorkspace(coordinator, {
      branchId: scope.branchId,
      repository: 'proof',
      sessions: [session],
      revision: 1,
      resident: true,
      generation: 'proof',
      lastUsed: 0,
      preparationMs: 0,
    });
    assert((await metadata.read()).state.localRecovery);
  } else {
    const { state } = await metadata.read();
    assert(state.localRecovery, 'Seed must complete on the first worker');
    await mkdir(coordinator.directory, { recursive: true });
    await restoreReplicas(
      path.join(coordinator.directory, 'replicas'),
      scope,
      state.localRecovery.hash,
      blobs,
      session
    );
    await coordinator.materialise();
    const tool = await coordinator.beginTool(session, 'verify', 'verify');
    const git = require('simple-git')(tool.workspace);
    assert.equal(
      await git.revparse(['HEAD']),
      await readFile(path.join(tool.workspace, 'expected-head.txt'), 'utf8')
    );
    assert.equal(
      await readFile(path.join(tool.workspace, 'node_modules/proof-dependency/index.js'), 'utf8'),
      'warm dependency'
    );
    assert.equal(
      await readFile(
        path.join(coordinator.directory, 'replicas', session, 'local-home/.local/proof'),
        'utf8'
      ),
      'private home'
    );
    await coordinator.abortTool(tool.ticket);
    await coordinator.drain();
  }
  console.log(
    JSON.stringify({
      passed: true,
      phase,
      host: config.origin,
      milliseconds: Math.round(performance.now() - started),
      gitAndDependenciesPreserved: phase === 'restore',
    })
  );
  await rm(root, { recursive: true, force: true });
} finally {
  await sql.end();
}
