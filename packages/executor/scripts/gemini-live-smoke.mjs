import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { openSmokeState } from './gemini-live-state.mjs';

const worker = fileURLToPath(new URL('./gemini-live-worker.mjs', import.meta.url));
export const visibleEnvMarker = 'agor-smoke-ordinary-variable';

export function agentEnvironment(home, tools, version, daemonUrl) {
  // No CI credential inheritance. Keep an ordinary variable to ensure SDK CI
  // redaction cannot accidentally make the key-containment assertion pass.
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: join(home, 'tmp'),
    LANG: 'C.UTF-8',
    NODE_NO_WARNINGS: '1',
    AGOR_TELEMETRY: '0',
    AGOR_VERSION: version,
    AGOR_MANAGED_AGENTIC_TOOLS: '1',
    AGOR_AGENTIC_TOOLS_DIR: tools,
    DAEMON_URL: daemonUrl,
    GITHUB_TOKEN: visibleEnvMarker,
  };
}

export function successfulToolResults(messages, name) {
  const blocks = messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  return blocks
    .filter((call) => call.type === 'tool_use' && call.name === name)
    .flatMap((call) =>
      blocks
        .filter(
          (result) =>
            result.type === 'tool_result' &&
            result.tool_use_id === call.id &&
            result.is_error === false
        )
        .map((result) => ({ call, result }))
    );
}

export function assertTask(task, status = 'completed') {
  // Fixed assertions only: assertion diagnostics must not dump stored content.
  assert.ok(task?.status === status, 'task did not reach expected terminal status');
  assert.ok(Boolean(task.completed_at), 'task completion was not stored');
}

export function assertRecall(messages, nonce) {
  assert.ok(
    !messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use')),
    'recall used tools instead of restored conversation'
  );
  assert.ok(
    messages.some(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'text' && b.text?.trim() === nonce)
    ),
    'nonce was not recalled'
  );
}

export function assertEnvironment(messages, key) {
  const results = successfulToolResults(messages, 'Bash').filter(
    ({ call }) => call.input?.command?.trim() === 'env'
  );
  assert.ok(results.length > 0, 'env did not execute successfully');
  for (const { result } of results) {
    const output = String(result.content);
    assert.ok(
      output.includes(`GITHUB_TOKEN=${visibleEnvMarker}`),
      'ordinary environment variable was stripped'
    );
    assert.ok(!output.includes(key), 'provider key reached env output');
    assert.ok(
      !/^(?:GEMINI_API_KEY|GOOGLE_API_KEY|GITHUB_SHA|SURFACE)=/m.test(output),
      'restricted environment reached tool'
    );
  }
}

export function assertSubagent(messages) {
  const results = successfulToolResults(messages, 'invoke_agent').filter(
    ({ call }) => call.input?.agent_name === 'smoke_worker'
  );
  assert.ok(results.length === 1, 'sub-agent did not complete once');
  // SDK tool success alone is insufficient: sub-agent errors/turn limits can
  // still return a successful outer tool. Inspect its SDK-generated envelope,
  // never the model-authored text after Result.
  const parts = JSON.parse(results[0].result.content);
  assert.ok(
    Array.isArray(parts) &&
      parts.some((part) =>
        part.functionResponse?.response?.output?.startsWith(
          "Subagent 'smoke_worker' finished.\nTermination Reason: GOAL\nResult:\n"
        )
      ),
    'sub-agent did not reach its goal'
  );
}

export async function reportSmoke(status, stage) {
  const line = `Gemini packaged-agent smoke: ${status} (${stage}).`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY)
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (process.env.GITHUB_OUTPUT)
    await fs.appendFile(process.env.GITHUB_OUTPUT, `validation=${status}\n`);
}

export async function runSmoke({ packageRoot, tools, apiKey, missingKeyProbe = false }) {
  const root = await fs.mkdtemp(join(tmpdir(), 'agor-gemini-live-'));
  await fs.chmod(root, 0o700);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  let state;
  let server;
  const transports = new Set();
  const children = new Set();
  let stage = 'setup';
  // Never emit captured output, even on failure: it may contain a regression's
  // leaked key or provider body. No logs, DB, SDK homes or prompts are artifacts.
  let logs = '';
  const originalConsole = { ...console };
  for (const name of ['log', 'info', 'warn', 'error', 'debug'])
    console[name] = (...args) => {
      logs += args.map(String).join(' ');
    };
  try {
    await fs.mkdir(join(home, 'tmp'), { recursive: true });
    await fs.mkdir(workspace);
    const require = createRequire(join(packageRoot, 'package.json'));
    const { simpleGit } = require('simple-git');
    const git = simpleGit(workspace);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'Smoke fixture');
    await git.addConfig('user.email', 'smoke@example.invalid');
    await fs.writeFile(join(workspace, 'source.txt'), 'before\n');
    await fs.writeFile(
      join(workspace, 'package.json'),
      '{"name":"smoke-fixture","version":"1.0.0"}\n'
    );
    await git.add(['source.txt', 'package.json']);
    await git.commit('test: seed smoke workspace');
    state = await openSmokeState(packageRoot, root);
    await state.core.initializeDatabase(state.db);
    const user = await state.repos.users.create({ email: 'smoke@example.invalid', role: 'member' });
    const repo = await state.repos.repos.create({
      slug: 'gemini-smoke',
      name: 'Gemini smoke',
      local_path: workspace,
      repo_type: 'local',
      default_branch: 'main',
    });
    const branch = await state.repos.branches.create({
      repo_id: repo.repo_id,
      name: 'main',
      branch_unique_id: 1,
      ref: 'main',
      path: workspace,
      created_by: user.user_id,
    });
    const session = async (mode) =>
      state.repos.sessions.create({
        branch_id: branch.branch_id,
        created_by: user.user_id,
        agentic_tool: 'gemini',
        permission_config: { mode },
        mcp_token: 'smoke-fixture-token',
      });
    const a = await session('autoEdit');
    const b = await session('yolo');
    const manifest = JSON.parse(await fs.readFile(join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'agor-live', 'requires the installed release package');

    const { createGeminiMcpFixture } = await import('./gemini-mcp-fixture.mjs');
    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );
    let mcpCalls = 0;
    server = createServer(async (request, response) => {
      if (
        request.url !== '/mcp' ||
        request.headers.authorization !== 'Bearer smoke-fixture-token'
      ) {
        response.writeHead(403).end();
        return;
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      transports.add(transport);
      const fixture = createGeminiMcpFixture(async () => {
        mcpCalls++;
      });
      response.on('close', () => {
        transports.delete(transport);
        void fixture.close();
      });
      try {
        await fixture.connect(transport);
        await transport.handleRequest(request, response);
      } catch {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const env = agentEnvironment(
      home,
      tools,
      manifest.version,
      `http://127.0.0.1:${server.address().port}`
    );
    const agentDir = join(home, '.gemini', 'agents');
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      join(agentDir, 'smoke_worker.md'),
      `---\nname: smoke_worker\ndescription: Read the smoke source file and report its contents.\ntools:\n  - read_file\n---\nRead source.txt with read_file, then report its contents. Do not edit any file.\n`
    );

    async function task(s, prompt, mode, stop = false) {
      const t = await state.repos.tasks.create({
        session_id: s.session_id,
        created_by: user.user_id,
        full_prompt: prompt,
        status: 'running',
      });
      const child = fork(worker, [], {
        cwd: workspace,
        env,
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        detached: true,
      });
      children.add(child);
      child.stdout.on('data', (data) => {
        logs += data.toString();
      });
      child.stderr.on('data', (data) => {
        logs += data.toString();
      });
      const exited = new Promise((done) =>
        child.once('exit', (code) => {
          done(code);
        })
      );
      const timeout = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 240_000);
      child.send({
        type: 'run',
        packageRoot,
        root,
        sessionId: s.session_id,
        taskId: t.task_id,
        prompt,
        permissionMode: mode,
        apiKey,
      });
      try {
        if (stop) {
          for (let i = 0; i < 1800; i++) {
            if (await fs.stat(join(workspace, 'stop-started')).catch(() => null)) break;
            assert.ok(
              child.exitCode === null && child.signalCode === null,
              'executor exited before the running tool'
            );
            await delay(100);
          }
          assert.ok(
            await fs.stat(join(workspace, 'stop-started')).catch(() => null),
            'tool did not start'
          );
          child.send('stop');
        }
        const code = await exited;
        assert.ok(code === (missingKeyProbe ? 1 : 0), 'executor failed');
      } finally {
        clearTimeout(timeout);
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
        if (child.exitCode !== null || child.signalCode !== null) children.delete(child);
      }
      const stored = await state.repos.tasks.findById(t.task_id);
      assertTask(stored, missingKeyProbe ? 'failed' : stop ? 'stopped' : 'completed');
      const messages = (await state.repos.messages.findBySessionId(s.session_id)).filter(
        (m) => m.task_id === t.task_id
      );
      return { stored, messages };
    }

    if (missingKeyProbe) {
      stage = 'offline missing-key adapter';
      const { stored } = await task(a, 'No inference should start.', 'autoEdit');
      assert.ok(
        stored.error_message?.includes('Gemini needs an API key'),
        'missing-key failure not stored'
      );
      return { status: 'not validated', stage };
    }
    stage = 'journey A';
    const nonce = randomBytes(24).toString('hex');
    const first = await task(
      a,
      `Read source.txt using read_file. Change its entire contents to after followed by a newline, and change package.json version to 1.0.1 using built-in edit tools. Call the Agor MCP smoke_ping tool with file_path source.txt. Remember this nonce only in conversation, never write it to any file: ${nonce}. Complete all actions now.`,
      'autoEdit'
    );
    assert.ok(successfulToolResults(first.messages, 'Read').length > 0, 'read result missing');
    for (const file of ['source.txt', 'package.json']) {
      assert.ok(
        ['Write', 'Edit'].some((name) =>
          successfulToolResults(first.messages, name).some(({ call }) => {
            const target = call.input?.file_path;
            return typeof target === 'string' && (target === file || target.endsWith(`/${file}`));
          })
        ),
        'stored edit result missing'
      );
    }
    assert.ok(
      (await fs.readFile(join(workspace, 'source.txt'), 'utf8')) === 'after\n',
      'source edit missing'
    );
    assert.ok(
      JSON.parse(await fs.readFile(join(workspace, 'package.json'), 'utf8')).version === '1.0.1',
      'build-file edit missing'
    );
    assert.ok(
      mcpCalls > 0 && successfulToolResults(first.messages, 'agor_smoke_ping').length > 0,
      'MCP result missing'
    );
    const recalled = await task(
      a,
      'Reply with exactly the nonce from our previous turn, no other text. Do not use tools.',
      'autoEdit'
    );
    assertRecall(recalled.messages, nonce);
    assert.ok(
      !recalled.messages.some((m) =>
        JSON.stringify(m.content).includes('Earlier Gemini conversation could not be restored')
      ),
      'history was not restored'
    );

    stage = 'journey B';
    const bypass = await task(
      b,
      'Run the exact shell command env (no redirection or filtering). Then run printf shell-ok > shell-proof.txt. Invoke the smoke_worker sub-agent once to read source.txt and wait for it to complete. Do all three actions.',
      'yolo'
    );
    assertEnvironment(bypass.messages, apiKey);
    assert.ok(
      (await fs.readFile(join(workspace, 'shell-proof.txt'), 'utf8')) === 'shell-ok',
      'shell effect missing'
    );
    assertSubagent(bypass.messages);
    await task(
      b,
      `Run this foreground shell command and wait for it to finish: node -e "require('node:fs').writeFileSync('stop-started','started');setTimeout(()=>{},120000)". Do not run it in the background.`,
      'yolo',
      true
    );
    const followup = await task(
      b,
      'Write after-stop.txt containing exactly resumed using a built-in write tool.',
      'yolo'
    );
    assert.ok(
      (await fs.readFile(join(workspace, 'after-stop.txt'), 'utf8')) === 'resumed',
      'follow-up effect missing'
    );
    assert.ok(
      successfulToolResults(followup.messages, 'Write').length > 0,
      'follow-up result missing'
    );

    stage = 'privacy';
    assert.ok(!logs.includes(apiKey) && !logs.includes(nonce), 'private content reached logs');
    for (const s of [a, b]) {
      const messages = await state.repos.messages.findBySessionId(s.session_id);
      assert.ok(!JSON.stringify(messages).includes(apiKey), 'key reached transcript');
    }
    for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const bytes = await fs.readFile(join(entry.parentPath, entry.name));
      assert.ok(!bytes.includes(Buffer.from(apiKey)), 'key reached file');
    }
    const taskTemp = join(home, '.gemini', 'agor-task-tmp');
    assert.ok((await fs.readdir(taskTemp).catch(() => [])).length === 0, 'task temp was retained');
    return { status: 'validated', stage: 'both journeys' };
  } catch {
    return { status: 'failed', stage };
  } finally {
    for (const child of children) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      await new Promise((done) =>
        child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', done)
      );
    }
    for (const transport of transports) await transport.close();
    if (server) await new Promise((done) => server.close(done));
    state?.close();
    try {
      await fs.rm(root, { recursive: true, force: true });
    } finally {
      Object.assign(console, originalConsole);
    }
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  delete process.env.GEMINI_API_KEY;
  if (!apiKey) {
    await reportSmoke('not validated', 'no GEMINI_API_KEY');
    return;
  }
  const packageRoot = resolve(process.argv[2] ?? '');
  const tools = resolve(process.argv[3] ?? '');
  const result = await runSmoke({ packageRoot, tools, apiKey });
  await reportSmoke(result.status, result.stage);
  if (result.status !== 'validated') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async () => {
    await reportSmoke('failed', 'harness setup');
    process.exitCode = 1;
  });
}
