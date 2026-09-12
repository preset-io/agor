// Run on EC2 with the release image, a read-only repository, and a disposable
// XFS proof root. Real S3, in-memory metadata; no model/API timing is included.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const runtime = '/opt/agor-runtime/lib/node_modules/agor-live/dist/executor';
const require = createRequire(`${runtime}/workspaces/worker.js`);
const { BranchWorkspaceCoordinator, DEFAULT_EXCLUDES } = await import(
  require.resolve('@agor/core/workspaces')
);
const { S3WorkspaceBlobs } = await import(`${runtime}/workspaces/s3-blobs.js`);
const config = JSON.parse(await readFile('/run/agor-worker/config.json', 'utf8'));
const source = process.argv[2];
assert(source, 'Pass a read-only source repository path');
const root = await mkdtemp('/proof/source-');
try {
  for (const phase of ['cold-cache', 'warm-cache']) {
    let state = null;
    const metadata = {
      async read() {
        return { state: structuredClone(state), now: Date.now() };
      },
      async mutate(work) {
        const next = work(structuredClone(state), Date.now());
        state = structuredClone(next.state);
        return structuredClone(next.result);
      },
    };
    const scope = { tenantId: 'default', branchId: randomUUID() };
    const blobs = new S3WorkspaceBlobs(
      config.bucket,
      scope.tenantId,
      undefined,
      undefined,
      path.join(root, 'cache')
    );
    const c = new BranchWorkspaceCoordinator(scope, metadata, blobs, {
      root: path.join(root, phase),
      host: 'preparation-proof',
      leaseMs: 600000,
      toolLeaseMs: 600000,
      clone: 'reflink',
      maximumBytes: 20 * 1024 ** 3,
      maximumFiles: 250000,
      minimumFreeBytes: 5 * 1024 ** 3,
      minimumFreeInodes: 100000,
      maximumActiveTools: 8,
      maximumReceipts: 100,
      exclude: DEFAULT_EXCLUDES,
    });
    const start = performance.now();
    await c.materialise(source, undefined, false);
    const admitted = performance.now();
    const tool = await c.beginTool('proof', randomUUID(), randomUUID());
    const ready = performance.now();
    assert((await readFile(path.join(tool.workspace, 'README.md'))).length > 0);
    console.log(
      JSON.stringify({
        phase,
        materialiseMs: Math.round(admitted - start),
        replicaMs: Math.round(ready - admitted),
        firstReadMs: Math.round(performance.now() - start),
        entries: Object.keys(state.tree).length,
        metadata: 'in-memory',
        blobs: 'S3',
        clone: 'reflink',
      })
    );
    await c.abortTool(tool.ticket);
    await c.drain();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
