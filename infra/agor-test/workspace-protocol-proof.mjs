// Runs on an isolated AWS worker test root. Uses real worker HTTP, Docker,
// PostgreSQL and S3; the Agor authorization API and model process are fixtures.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
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
const gitRequire = createRequire('/opt/agor-runtime/lib/node_modules/agor-live/package.json');
const sourceGit = gitRequire('simple-git')(source);
if (!(await sourceGit.checkIsRepo())) {
  await sourceGit.init();
  await sourceGit.addConfig('user.name', 'Workspace proof');
  await sourceGit.addConfig('user.email', 'proof@agor.test');
  await sourceGit.add('base.txt');
  await sourceGit.commit('fixture history');
}

if (!(await sourceGit.tags()).all.includes('proof-version'))
  await sourceGit.addAnnotatedTag('proof-version', 'fixture version');
await writeFile(
  path.join(source, 'expected-head.txt'),
  (await sourceGit.revparse(['HEAD'])).trim()
);
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
// The production worker claims its Task and sends startup telemetry over the
// same authenticated Socket.IO protocol as the native executor.
const require = createRequire('/opt/agor-runtime/lib/node_modules/agor-live/package.json');
const io = new (require('socket.io').Server)(api);
io.use((socket, next) =>
  next(
    tokens.includes(socket.handshake.auth.token) ? undefined : new Error('Invalid fixture token')
  )
);
io.on('connection', (socket) => {
  for (const method of [
    'find',
    'create',
    'connectExecutor',
    'reportRuntimeTelemetry',
    'get',
    'patch',
    'reportTerminationComplete',
  ]) {
    socket.on(method, (service, input, ...args) => {
      const acknowledge = args.at(-1);
      if (typeof acknowledge !== 'function') return;
      if (service === 'messages') {
        if (method === 'find') return acknowledge(null, { data: [], total: 0 });
        return acknowledge(null, typeof input === 'object' ? input : { message_id: input });
      }
      if (service !== 'tasks') return acknowledge({ message: 'Unknown fixture service' });
      const taskId = typeof input === 'string' ? input : input.task_id;
      acknowledge(null, { task_id: taskId, status: 'running' });
    });
  }
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
const dispatch = (index, command, expected, checkTranscript = false, expectedExit = 0) =>
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
        prompt: JSON.stringify({ command, expected, checkTranscript, expectedExit }),
      },
    },
  });
const gitCommand = (code) => {
  const script = `const g=require('/opt/agor-runtime/lib/node_modules/agor-live/node_modules/simple-git')('/workspace'); (async()=>{${code}})().catch(e=>{console.error(e);process.exit(1)});`;
  return `node -e '${script.replaceAll("'", "'\\''")}'`;
};

try {
  if (phase === 'initial') {
    const started = performance.now();
    const conversation = await dispatch(0, '', 'no-tools');
    assert.match(conversation, /PROOF_SDK_READY_BEFORE_FILES/);
    assert.match(conversation, /PROOF_EXECUTOR_OK/);
    assert.equal(
      JSON.parse(await call('/placement', { tenantId, branchId })).revision,
      null,
      'Conversation-only prompt must not materialise source'
    );
    console.log(
      JSON.stringify({
        conversationWithoutFilesMs: Math.round(performance.now() - started),
        sourceUntouched: true,
      })
    );
    tasks[0] = randomUUID();
    tokens[0] = `fixture.${claims(0)}.fixture`;
    const { S3WorkspaceBlobs } = await import(`${runtime}/workspaces/s3-blobs.js`);
    const originalPut = S3WorkspaceBlobs.prototype.put;
    const delayMarker = Buffer.from('startup cancellation fixture');
    await writeFile(path.join(source, 'startup-delay.txt'), delayMarker);
    S3WorkspaceBlobs.prototype.put = async function (hash, content) {
      if (content.equals(delayMarker)) await new Promise((resolve) => setTimeout(resolve, 3000));
      return originalPut.call(this, hash, content);
    };
    try {
      assert.match(
        await dispatch(0, 'printf unsafe > preparation-stop.txt', 'stopped'),
        /PROOF_EXECUTOR_OK/
      );
      assert.equal(JSON.parse(await call('/placement', { tenantId, branchId })).revision, null);
      console.log(JSON.stringify({ stopDuringPreparation: true, sourceUntouched: true }));
    } finally {
      S3WorkspaceBlobs.prototype.put = originalPut;
      await rm(path.join(source, 'startup-delay.txt'));
    }
    tasks[0] = randomUUID();
    tokens[0] = `fixture.${claims(0)}.fixture`;
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
    // Reuse the same session with new task ids, as successive user prompts do.
    const nextPrompt = () => {
      tasks[0] = randomUUID();
      tokens[0] = `fixture.${claims(0)}.fixture`;
    };
    nextPrompt();
    assert.match(
      await dispatch(
        0,
        [
          'set -e',
          'mkdir -p frontend npm-fixture .cache',
          `printf '%s' '{"name":"local-proof","version":"1.0.0","main":"index.js","bin":{"local-proof":"cli.js"}}' > npm-fixture/package.json`,
          `printf '%s' 'module.exports=42' > npm-fixture/index.js`,
          `printf '#!/usr/bin/env node\\nconsole.log(42)\\n' > npm-fixture/cli.js`,
          'chmod +x npm-fixture/cli.js',
          'npm install --prefix frontend --no-audit --no-fund /workspace/npm-fixture',
          'npm install -g --no-audit --no-fund /workspace/npm-fixture',
          'python3 -m venv .venv',
          '.venv/bin/pip install --disable-pip-version-check six==1.17.0',
          'mkdir -p ~/.local/bin ~/.cache/pip ~/.nvm',
          'printf retained > ~/.local/bin/retained-proof',
          'printf retained > ~/.cache/pip/retained-proof',
          'printf retained > ~/.nvm/retained-proof',
          gitCommand(
            "await g.add(['alpha.txt']); await g.commit('private local commit'); require('fs').writeFileSync('.cache/private-head',await g.revparse(['HEAD']));"
          ),
        ].join('\n'),
        'committed'
      ),
      /PROOF_EXECUTOR_OK/
    );
    nextPrompt();
    assert.match(
      await dispatch(
        0,
        [
          'set -e',
          `node -e "require('assert').equal(require('./frontend/node_modules/local-proof'),42)"`,
          `.venv/bin/python -c "import six; assert six.__version__ == '1.17.0'"`,
          'test "$(cat ~/.local/bin/retained-proof)" = retained',
          'test "$(local-proof)" = 42',
          'test "$(cat ~/.cache/pip/retained-proof)" = retained',
          'test "$(cat ~/.nvm/retained-proof)" = retained',
          gitCommand(
            "require('assert').equal(await g.revparse(['HEAD']),require('fs').readFileSync('.cache/private-head','utf8'));"
          ),
        ].join('\n'),
        'committed'
      ),
      /PROOF_EXECUTOR_OK/
    );
    nextPrompt();
    assert.match(await dispatch(0, 'false | cat', 'committed', false, 1), /PROOF_EXECUTOR_OK/);
    nextPrompt();
    assert.match(
      await dispatch(0, "python3 -c 'a=bytearray(4*1024**3)' || true", 'committed', false, 137),
      /PROOF_EXECUTOR_OK/
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
          'npm and pip reuse across prompts',
          'private Git history and commits across prompts',
          'local user tools and caches across prompts',
          'pipeline failures remain failures',
          'OOM remains failure even when shell masks it',
          'checkpoint and drain',
        ],
      })
    );
  } else {
    const output = await dispatch(
      0,
      `set -e; test "$(cat alpha.txt)" = alpha; test "$(cat beta.txt)" = beta; test -f shared.txt; test -f foreground.txt; test ! -e late.txt; test ! -e node_modules/ignored; test ! -e .venv; ${gitCommand("require('assert').equal((await g.revparse(['HEAD'])).trim(),require('fs').readFileSync('expected-head.txt','utf8')); require('assert').equal((await g.raw(['describe','--tags'])).trim(),'proof-version');")}`,
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
          'initial Git history restored with matching HEAD',
          'filtered SDK transcript restoration',
          'next tool on recovered revision',
        ],
      })
    );
  }
} finally {
  await new Promise((resolve) => worker.server.close(resolve));
  await worker.sql.end();
  await new Promise((resolve) => io.close(resolve));
}
