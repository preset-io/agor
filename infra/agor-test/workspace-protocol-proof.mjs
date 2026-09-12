// Runs on an isolated AWS worker test root. Uses real worker HTTP, Docker,
// PostgreSQL and S3; the Agor authorization API and model process are fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const runtime = '/opt/agor-runtime/lib/node_modules/agor-live/dist/executor';
const { startWorker } = await import(`${runtime}/workspaces/worker.js`);
const phase = process.argv[2];
const config = JSON.parse(await readFile('/run/proof/config.json', 'utf8'));
const scope = JSON.parse(await readFile('/run/proof/scope.json', 'utf8'));
const { tenantId, branchId, sessions, tasks } = scope;
if (phase === 'restore') tasks[0] = randomUUID();
const source = '/var/lib/agor-proof/source';
await mkdir(source, { recursive: true });
await writeFile(path.join(source, 'base.txt'), 'original');
const claims = (index) =>
  Buffer.from(
    JSON.stringify({
      tenant_id: tenantId,
      branch_id: branchId,
      task_id: tasks[index],
      session_id: sessions[index],
    })
  ).toString('base64url');
const tokens = tasks.map((_, index) => `fixture.${claims(index)}.fixture`);
const api = createServer((req, res) => {
  if (!tokens.includes(req.headers.authorization?.replace('Bearer ', ''))) {
    res.writeHead(403);
    return res.end();
  }
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/sessions/')) {
    const id = req.url.split('/').pop();
    return res.end(
      JSON.stringify({
        branch_id: branchId,
        ...(phase === 'restore' ? { sdk_session_id: id } : {}),
      })
    );
  }
  if (req.url.startsWith('/branches/')) return res.end(JSON.stringify({ path: source }));
  if (req.url.startsWith('/tasks/')) return res.end(JSON.stringify({ status: 'running' }));
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => api.listen(18888, '0.0.0.0', resolve));
const worker = await startWorker('/run/proof/config.json');
await new Promise((resolve) => setTimeout(resolve, 100));
const headers = {
  authorization: `Bearer ${config.controlToken}`,
  'content-type': 'application/json',
};
const call = async (route, input) => {
  const res = await fetch(`http://127.0.0.1:${config.port}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return text;
};
const dispatch = (index, command, expected, checkTranscript = false) =>
  call('/dispatch', {
    tenantId,
    branchId,
    payload: {
      command: 'prompt',
      requiresReplicatedWorkspace: true,
      sessionToken: tokens[index],
      params: {
        sessionId: sessions[index],
        taskId: tasks[index],
        tool: 'claude-code',
        cwd: source,
        principalBranchAccess: 'write',
        prompt: JSON.stringify({ command, expected, checkTranscript }),
      },
    },
  });
try {
  if (phase === 'initial') {
    const outputs = await Promise.all([
      dispatch(
        0,
        'sleep 2; printf alpha > alpha.txt; mkdir -p node_modules; printf excluded > node_modules/ignored',
        'committed'
      ),
      dispatch(1, 'sleep 2; printf beta > beta.txt', 'committed'),
    ]);
    for (const output of outputs) assert.match(output, /PROOF_EXECUTOR_OK/);
    const conflicts = await Promise.all([
      dispatch(2, 'sleep 2; printf first > shared.txt', 'either'),
      dispatch(3, 'sleep 2; printf second > shared.txt', 'either'),
    ]);
    const results = conflicts.map((output) =>
      JSON.parse(
        output
          .split('\n')
          .find((line) => line.startsWith('PROOF_RESULT='))
          .slice('PROOF_RESULT='.length)
      )
    );
    assert.deepEqual(results.map((r) => r.outcome.status).sort(), ['committed', 'conflict']);
    assert.equal(results[0].baseRevision, results[1].baseRevision);
    // New tool sees both disjoint commits; background writer must be killed
    // before publication, and repeated HTTP invocation returns its first result.
    const output = await dispatch(
      4,
      'test "$(cat alpha.txt)" = alpha; test "$(cat beta.txt)" = beta; (sleep 2; printf escaped > late.txt) >/dev/null 2>&1 & printf now > foreground.txt',
      'committed'
    );
    assert.match(output, /PROOF_EXECUTOR_OK/);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.match(
      await dispatch(
        5,
        'printf interrupted > interrupted.txt; sleep 20; printf late > after-stop.txt',
        'stopped'
      ),
      /PROOF_EXECUTOR_OK/
    );
    const read = JSON.parse(
      await call('/read-command', {
        tenantId,
        branchId,
        access: 'read',
        payload: {
          command: 'branch.files.browse',
          sessionToken: tokens[0],
          params: { branchId },
        },
      })
    );
    assert(
      !read.data.files.some(
        (f) =>
          ['late.txt', 'interrupted.txt', 'after-stop.txt'].includes(f.path) ||
          f.path.includes('node_modules')
      )
    );
    await call('/drain', {});
    console.log(
      JSON.stringify({
        phase,
        passed: true,
        tests: [
          'isolated Docker tools',
          'disjoint atomic commits',
          'same-base structured conflict',
          'next-tool refresh',
          'duplicate HTTP idempotency',
          'background process reaping',
          'Stop contains tools before acknowledgement',
          'excluded dependencies',
          'checkpoint and drain',
        ],
      })
    );
  } else {
    const output = await dispatch(
      0,
      'test "$(cat alpha.txt)" = alpha; test "$(cat beta.txt)" = beta; test -f shared.txt; test -f foreground.txt; test ! -e late.txt; test ! -e node_modules/ignored',
      'committed',
      true
    );
    assert.match(output, /PROOF_EXECUTOR_OK/);
    await call('/drain', {});
    console.log(
      JSON.stringify({
        phase,
        passed: true,
        tests: [
          'cross-AZ worker activation',
          'S3-backed code restoration',
          'filtered SDK transcript restoration',
          'next tool on recovered revision',
        ],
      })
    );
  }
} finally {
  await new Promise((resolve) => worker.server.close(resolve));
  await worker.sql.end();
  await new Promise((resolve) => api.close(resolve));
}
