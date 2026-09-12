// Real RDS/S3 recovery with an abandoned tool and no checkpoint. No model calls.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire('/opt/agor-runtime/lib/node_modules/agor-live/package.json');
const { connectWorkspaceAuthority } = await import(
  '/opt/agor-runtime/lib/node_modules/agor-live/dist/executor/workspaces/connection.js'
);
const { BranchWorkspaceCoordinator } = await import(require.resolve('@agor/core/workspaces'));
const { WorkerSqlAuthority } = await import(
  '/opt/agor-runtime/lib/node_modules/agor-live/dist/executor/workspaces/sql-authority.js'
);
const { S3WorkspaceBlobs } = await import(
  '/opt/agor-runtime/lib/node_modules/agor-live/dist/executor/workspaces/s3-blobs.js'
);
const config = JSON.parse(await readFile('/run/proof/config.json', 'utf8'));
const scope = JSON.parse(await readFile('/run/proof/crash-scope.json', 'utf8'));
const phase = process.argv[2];
const sql = await connectWorkspaceAuthority(config);
const metadata = new WorkerSqlAuthority(sql, scope);
const c = new BranchWorkspaceCoordinator(
  scope,
  metadata,
  new S3WorkspaceBlobs(config.bucket, scope.tenantId),
  {
    root: '/var/lib/agor-proof/crash',
    host: phase === 'recover' ? 'crash-worker-b' : 'crash-worker-a',
    clone: 'reflink',
    leaseMs: 5000,
    toolLeaseMs: 60000,
    maximumBytes: 1000000,
    maximumFiles: 1000,
    minimumFreeBytes: 0,
    minimumFreeInodes: 0,
    maximumActiveTools: 4,
    maximumReceipts: 100,
    exclude: [],
  }
);
try {
  if (phase === 'abandon') {
    await mkdir('/var/lib/agor-proof/crash-source', { recursive: true });
    await writeFile('/var/lib/agor-proof/crash-source/original', 'base');
    await c.materialise('/var/lib/agor-proof/crash-source');
    const first = await c.beginTool('first', 'first', 'first');
    await writeFile(`${first.workspace}/a`, 'acknowledged-a');
    await writeFile(`${first.workspace}/b`, 'acknowledged-b');
    assert.equal((await c.completeTool(first.ticket)).status, 'committed');
    const stale = await c.beginTool('stale', 'stale', 'stale');
    await writeFile(`${stale.workspace}/a`, 'must-not-win');
    await writeFile('/var/lib/agor-proof/crash-ticket.json', JSON.stringify(stale.ticket));
    assert.equal((await metadata.read()).state.checkpoint, undefined);
    console.log(
      JSON.stringify({ phase, passed: true, revision: 1, checkpoint: false, abandonedTool: true })
    );
    // Exit without abort, checkpoint or placement release, as on worker loss.
  } else if (phase === 'recover') {
    let state = await metadata.read();
    if (state.now <= state.state.leaseUntil)
      await new Promise((resolve) => setTimeout(resolve, state.state.leaseUntil - state.now + 100));
    state = await metadata.read();
    assert(state.now > state.state.leaseUntil);
    assert.equal(await c.restore(), 1);
    const next = await c.beginTool('replacement', 'replacement', 'replacement');
    assert.equal(await readFile(`${next.workspace}/a`, 'utf8'), 'acknowledged-a');
    assert.equal(await readFile(`${next.workspace}/b`, 'utf8'), 'acknowledged-b');
    await writeFile(`${next.workspace}/a`, 'replacement');
    assert.equal((await c.completeTool(next.ticket)).status, 'committed');
    await c.drain();
    console.log(
      JSON.stringify({ phase, passed: true, revision: 2, recoveredWithoutCheckpoint: true })
    );
  } else {
    const ticket = JSON.parse(await readFile('/var/lib/agor-proof/crash-ticket.json', 'utf8'));
    await assert.rejects(() => c.completeTool(ticket), /fenced|ownership|lease/i);
    assert.equal((await metadata.read()).state.revision, 2);
    console.log(JSON.stringify({ phase, passed: true, staleHostFenced: true, revision: 2 }));
  }
} finally {
  await sql.end();
}
