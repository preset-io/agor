// Isolated packaged-runtime smoke test. No production branch data or AWS credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { BranchWorkspaceCoordinator, LocalWorkspaceBlobs } = await import(process.argv[2]);
const root = await mkdtemp(path.join(tmpdir(), 'agor-workspace-smoke-'));
try {
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
  const scope = { tenantId: 'smoke', branchId: 'smoke' };
  const options = {
    root: path.join(root, 'host-a'),
    host: 'host-a',
    leaseMs: 60000,
    toolLeaseMs: 30000,
    clone: 'copy',
    maximumBytes: 1000000,
    maximumFiles: 1000,
    minimumFreeBytes: 0,
    minimumFreeInodes: 0,
    maximumActiveTools: 8,
    maximumReceipts: 100,
    exclude: [],
  };
  const blobs = new LocalWorkspaceBlobs(path.join(root, 'blobs'), scope.tenantId);
  const c = new BranchWorkspaceCoordinator(scope, metadata, blobs, options);
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'a'), 'base');
  await c.materialise(source);
  const execute = (cwd, file, content) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['-e', 'require("node:fs").writeFileSync(process.argv[1],process.argv[2])', file, content],
        { cwd, env: {}, stdio: 'pipe' }
      );
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
  const first = await c.beginTool('one', 'first', 'first');
  const second = await c.beginTool('two', 'second', 'second');
  assert.equal(first.ticket.baseRevision, second.ticket.baseRevision);
  assert.notEqual(first.workspace, second.workspace);
  await Promise.all([execute(first.workspace, 'a', 'one'), execute(second.workspace, 'b', 'two')]);
  const outcomes = await Promise.all([c.completeTool(first.ticket), c.completeTool(second.ticket)]);
  assert(outcomes.every((o) => o.status === 'committed'));
  const a = await c.beginTool('one', 'conflict-one', 'conflict-one');
  const b = await c.beginTool('two', 'conflict-two', 'conflict-two');
  assert.equal(await readFile(path.join(a.workspace, 'b'), 'utf8'), 'two');
  await Promise.all([execute(a.workspace, 'a', 'winner'), execute(b.workspace, 'a', 'loser')]);
  assert.equal((await c.completeTool(a.ticket)).status, 'committed');
  assert.equal((await c.completeTool(b.ticket)).status, 'conflict');
  await c.drain();
  const next = new BranchWorkspaceCoordinator(scope, metadata, blobs, {
    ...options,
    root: path.join(root, 'host-b'),
    host: 'host-b',
  });
  assert.equal(await next.restore(), 3);
  const restored = await next.beginTool('three', 'restore', 'restore');
  assert.equal(await readFile(path.join(restored.workspace, 'a'), 'utf8'), 'winner');
  assert.equal(await readFile(path.join(restored.workspace, 'b'), 'utf8'), 'two');
  await next.abortTool(restored.ticket);
  console.log(
    JSON.stringify({
      passed: true,
      revision: 3,
      metadata: 'in-memory',
      blobs: 'local',
      checks: [
        'isolated child processes',
        'disjoint commits',
        'refresh',
        'conflict',
        'checkpoint',
        'restore',
      ],
    })
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
