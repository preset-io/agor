/** No provider requests: real pinned SDK, real tools, fake content generator. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGeminiPolicy, installGeminiPolicy } from '../src/sdk-handlers/gemini/policy.js';
import {
  enterGeminiRuntime,
  findGeminiRecording,
  geminiSessionId,
} from '../src/sdk-handlers/gemini/runtime.js';

const root =
  process.env.GEMINI_CONTRACT_ROOT ??
  (await fs.mkdtemp(path.join(os.tmpdir(), 'agor-gemini-contract-')));
process.env.GEMINI_CLI_HOME = path.join(root, 'home');
process.env.HOME = path.join(root, 'home');
delete process.env.GITHUB_SHA;
delete process.env.SURFACE;
delete process.env.AGOR_MANAGED_AGENTIC_TOOLS;
globalThis.fetch = async () => {
  throw new Error('Network forbidden in offline contract');
};
// Fail immediately rather than quietly succeeding if a tool attempts HTTP.
for (const transport of [http, https]) {
  Object.assign(transport.default, {
    request: () => {
      throw new Error('Network forbidden in offline contract');
    },
    get: () => {
      throw new Error('Network forbidden in offline contract');
    },
  });
}
const debugFile = path.join(root, 'inherited-debug.log');
process.env.GEMINI_DEBUG_LOG_FILE = debugFile;
await import('../src/sdk-handlers/gemini/permission-mapper.js');
const G = await import('@google/gemini-cli-core');
const workspace = path.join(root, 'workspace');
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(process.env.HOME, { recursive: true });
const fake = path.join(root, 'responses.jsonl');
await fs.writeFile(
  fake,
  `${JSON.stringify({
    method: 'generateContentStream',
    response: [
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'offline response' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, totalTokenCount: 14 },
        modelVersion: 'reported-model',
      },
    ],
  })}\n`
);
const tally = path.join(root, 'mcp-executions');
const fixture = fileURLToPath(new URL('./gemini-mcp-fixture.mjs', import.meta.url));
const agentDirectory = path.join(process.env.HOME, '.gemini', 'agents');
await fs.mkdir(agentDirectory, { recursive: true });
for (const [name, server] of [
  ['own_agent', 'private-server'],
  ['clash_agent', 'agor'],
  ['wildcard_agent', '"*"'],
]) {
  await fs.writeFile(
    path.join(agentDirectory, `${name}.md`),
    `---
name: ${name}
description: offline fixture
tools:
  - read_file
mcp_servers:
  ${server}:
    command: ${process.execPath}
    args: ["${fixture}", "${path.join(root, 'agent-started')}"]
---
Offline fixture agent.
`
  );
}
const originalMemory = G.Config.prototype.startMemoryService;
G.Config.prototype.startMemoryService = async () => {
  throw new Error('Must not start memory service');
};
let calls = 0;
async function config(mode = G.ApprovalMode.AUTO_EDIT, session = 'session-one') {
  const servers = { agor: new G.MCPServerConfig(process.execPath, [fixture, tally]) };
  servers.agor.excludeTools = ['excluded'];
  const c = new G.Config({
    sessionId: geminiSessionId(session),
    targetDir: workspace,
    cwd: workspace,
    model: 'gemini-3.8-flash',
    approvalMode: mode,
    interactive: false,
    debugMode: false,
    folderTrust: true,
    trustedFolder: true,
    fakeResponsesNonStrict: fake,
    usageStatisticsEnabled: false,
    telemetry: { enabled: false, logPrompts: false },
    enableHooks: false,
    extensionsEnabled: false,
    enableEnvironmentVariableRedaction: false,
    policyEngineConfig: buildGeminiPolicy(G, mode, servers),
    mcpServers: servers,
    enableAgents: true,
  });
  await c.storage.initialize();
  const file = await findGeminiRecording(G, c, c.getSessionId());
  const record = file ? await G.loadConversationRecord(file) : undefined;
  await c.initialize();
  installGeminiPolicy(G, c);
  await c.refreshAuth(G.AuthType.USE_GEMINI, 'offline-not-a-real-key');
  await c.getGeminiClient().setTools();
  if (record && file)
    await c.getGeminiClient().resumeChat(G.convertSessionToClientHistory(record.messages), {
      conversation: record,
      filePath: file,
    });
  return c;
}
async function call(
  c: InstanceType<typeof G.Config>,
  name: string,
  args: Record<string, unknown>,
  signal = new AbortController().signal
) {
  const scheduler = new G.Scheduler({
    context: c,
    messageBus: c.getMessageBus(),
    getPreferredEditor: () => undefined,
    schedulerId: `offline-${++calls}`,
  });
  const request = { callId: `call-${calls}`, name, args, prompt_id: 'offline' };
  try {
    return (
      await scheduler.schedule(
        [request as import('@google/gemini-cli-core').ToolCallRequestInfo],
        signal
      )
    )[0];
  } finally {
    scheduler.dispose();
  }
}
async function drain(c: InstanceType<typeof G.Config>, text: string) {
  for await (const event of c
    .getGeminiClient()
    .sendMessageStream([{ text }], new AbortController().signal, 'offline')) {
    assert.notEqual(event.type, G.GeminiEventType.Error);
  }
}
const capturedLogs: unknown[][] = [];
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
  info: console.info,
};
for (const method of ['log', 'warn', 'error', 'debug', 'info'] as const)
  console[method] = (...args) => {
    capturedLogs.push(args);
  };
let cleanup: (() => Promise<void>) | undefined;
try {
  process.env.GEMINI_API_KEY = 'HOSTILE_PROVIDER_KEY';
  process.env.ANTHROPIC_API_KEY = 'HOSTILE_PROVIDER_KEY';
  process.env.GITHUB_TOKEN = 'ordinary-user-variable';
  assert.throws(
    () =>
      buildGeminiPolicy(G, G.ApprovalMode.YOLO, {
        '*': new G.MCPServerConfig(),
      }),
    /MCP server names must be exact/
  );
  const taskRoot = path.join(process.env.HOME!, '.gemini', 'agor-task-tmp');
  await fs.mkdir(taskRoot, { recursive: true });
  const dead = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { enterGeminiRuntime } from ${JSON.stringify(new URL('../src/sdk-handlers/gemini/runtime.ts', import.meta.url).href)};
     await enterGeminiRuntime(); process.stdout.write(process.env.TMPDIR); process.exit(0);`,
    ],
    { encoding: 'utf8', env: process.env, timeout: 30000 }
  );
  assert.equal(dead.status, 0);
  const stale = dead.stdout;
  const owner = JSON.parse(await fs.readFile(path.join(stale, 'owner.json'), 'utf8'));
  const live = path.join(taskRoot, `${process.pid}-live-fixture`);
  const foreign = path.join(taskRoot, `${owner.pid}-foreign-fixture`);
  const unknown = path.join(taskRoot, `${owner.pid}-unknown-fixture`);
  for (const directory of [live, foreign, unknown]) await fs.mkdir(directory);
  await fs.writeFile(path.join(live, 'owner.json'), JSON.stringify({ ...owner, pid: process.pid }));
  await fs.writeFile(
    path.join(foreign, 'owner.json'),
    JSON.stringify({ ...owner, namespace: 'foreign' })
  );
  cleanup = await enterGeminiRuntime();
  assert.equal(await fs.stat(stale).catch(() => null), null);
  for (const directory of [live, foreign, unknown]) {
    assert.ok(
      (await fs.stat(directory)).isDirectory(),
      'Live, foreign and unknown owners survive cleanup'
    );
    await fs.rm(directory, { recursive: true });
  }
  const temp = process.env.TMPDIR!;
  assert.equal((await fs.stat(temp)).mode & 0o777, 0o700);
  assert.equal(process.env.GEMINI_API_KEY, undefined);
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(process.env.GITHUB_TOKEN, 'ordinary-user-variable');
  if (process.argv.includes('--resume-child')) {
    const c = await config(G.ApprovalMode.AUTO_EDIT, 'session-one');
    assert.match(JSON.stringify(c.getGeminiClient().getHistory()), /NONCE-session-one/);
    await drain(c, 'follow-up');
    await c.dispose();
  } else {
    const ae = await config();
    assert.equal(
      (await ae.getPolicyEngine().check({ name: 'unknown_future_tool', args: {} })).decision,
      G.PolicyDecision.DENY
    );
    for (const name of ['run_shell_command', 'web_fetch', 'google_web_search']) {
      const result = await ae.getPolicyEngine().check({ name, args: { command: 'echo denied' } });
      assert.equal(result.decision, G.PolicyDecision.DENY);
      assert.match(result.rule?.denyMessage ?? '', /Bypass/);
    }
    const yolo = await config(G.ApprovalMode.YOLO, 'session-two');
    assert.equal(
      (await yolo.getPolicyEngine().check({ name: 'unknown_future_tool', args: {} })).decision,
      G.PolicyDecision.ALLOW
    );
    for (const c of [ae, yolo]) {
      for (const name of ['ask_user', 'enter_plan_mode', 'exit_plan_mode', 'tracker_future']) {
        assert.equal(
          (await c.getPolicyEngine().check({ name, args: {} })).decision,
          G.PolicyDecision.DENY
        );
      }
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside, { recursive: true });
      await fs.symlink(outside, path.join(workspace, `link-${calls}`));
      const link = `link-${calls}`;
      await fs.symlink(path.join(outside, 'missing'), path.join(workspace, `dangling-${calls}`));
      const dangling = `dangling-${calls}`;
      for (const file of [
        'package.json',
        './package.json',
        '@package.json',
        path.join(workspace, 'package.json'),
        'new/package.json',
        `file://${workspace}/package.json`,
      ]) {
        const result = await call(c, 'write_file', {
          file_path: file,
          content: '{"name":"edited"}\n',
        });
        assert.equal(
          result.status,
          'success',
          `${c.getApprovalMode()} ${file}: ${result.response?.error?.message}`
        );
      }
      const replaced = await call(c, 'replace', {
        file_path: 'package.json',
        old_string: 'edited',
        new_string: 'changed',
        instruction: 'rename',
      });
      assert.equal(replaced.status, 'success');
      for (const file of [
        '../outside/package.json',
        path.join(outside, 'package.json'),
        `${link}/package.json`,
        `${dangling}/package.json`,
        '%2e%2e/outside/package.json',
      ]) {
        const result = await call(c, 'write_file', { file_path: file, content: 'bad' });
        assert.notEqual(result.status, 'success', file);
      }
      assert.notEqual(
        (
          await call(c, 'write_file', {
            file_path: 'package.json',
            content: 'bad',
            additional_permissions: {},
          })
        ).status,
        'success'
      );
      for (const [server, subagent] of [
        ['unconfigured', undefined],
        [undefined, 'child'],
      ]) {
        const result = await c
          .getPolicyEngine()
          .check(
            { name: 'write_file', args: { file_path: 'package.json', content: 'bad' } },
            server,
            undefined,
            subagent
          );
        assert.equal(result.decision, G.PolicyDecision.DENY);
      }
    }
    const engine = yolo.getPolicyEngine();
    for (const [server, agent, decision] of [
      ['agor', undefined, G.PolicyDecision.ALLOW],
      ['rogue', undefined, G.PolicyDecision.DENY],
      ['private-server', 'own_agent', G.PolicyDecision.ALLOW],
      ['private-server', undefined, G.PolicyDecision.DENY],
      ['private-server', 'other_agent', G.PolicyDecision.DENY],
      ['rogue', 'wildcard_agent', G.PolicyDecision.DENY],
    ] as const) {
      assert.equal(
        (
          await engine.check(
            { name: G.generateValidName(`${server}_search`), args: {} },
            server,
            undefined,
            agent
          )
        ).decision,
        decision
      );
    }
    for (const agent of ['clash_agent', 'wildcard_agent']) {
      assert.equal(
        (await engine.check({ name: 'invoke_agent', args: { agent_name: agent, task: 'test' } }))
          .decision,
        G.PolicyDecision.DENY
      );
    }
    assert.equal(
      (
        await engine.check(
          { name: G.generateValidName('agor_excluded'), args: {} },
          'agor',
          undefined,
          'own_agent'
        )
      ).decision,
      G.PolicyDecision.DENY
    );
    assert.equal(
      (
        await call(yolo, G.generateValidName('agor_edit_file'), {
          file_path: path.join(workspace, 'package.json'),
        })
      ).status,
      'error'
    );
    assert.equal(await fs.stat(tally).catch(() => null), null, 'MCP build edit must never execute');
    assert.equal(
      (
        await call(yolo, G.generateValidName('agor_edit_file'), {
          file_path: path.join(workspace, 'notes.txt'),
        })
      ).status,
      'success'
    );
    assert.equal(await fs.readFile(tally, 'utf8'), 'executed\n');
    assert.equal(await fs.stat(path.join(root, 'agent-started')).catch(() => null), null);
    const env = await call(yolo, 'run_shell_command', {
      command: 'env',
      description: 'Offline credential check',
    });
    assert.equal(env.status, 'success');
    assert.ok(
      !/HOSTILE_PROVIDER_KEY/.test(JSON.stringify(env.response)),
      'Provider credential reached a tool'
    );
    assert.match(JSON.stringify(env.response), /ordinary-user-variable/);
    const redirection = await call(yolo, 'run_shell_command', {
      command: 'echo ok > redirected.txt',
      description: 'Offline redirection',
    });
    assert.equal(redirection.status, 'success');
    assert.equal((await fs.readFile(path.join(workspace, 'redirected.txt'), 'utf8')).trim(), 'ok');
    await drain(ae, 'NONCE-session-one');
    assert.doesNotMatch(JSON.stringify(yolo.getGeminiClient().getHistory()), /NONCE-session-one/);
    // Exercise the adapter with the real SDK; replace only the model transport.
    const { GeminiPromptService } = await import('../src/sdk-handlers/gemini/prompt-service.js');
    const originalAuth = G.Config.prototype.refreshAuth;
    const originalAttempts = G.Config.prototype.getMaxAttempts;
    G.Config.prototype.getMaxAttempts = () => 1;
    let failReportWrite = false;
    G.Config.prototype.refreshAuth = async function (...args) {
      await originalAuth.apply(this, args);
      this.getContentGenerator().generateContentStream = async () => {
        if (failReportWrite) process.env.TMPDIR = path.join(process.env.TMPDIR!, 'nonexistent');
        throw Object.assign(new Error('HOSTILE_PROVIDER_BODY API_KEY_INVALID'), { status: 400 });
      };
    };
    try {
      const sessions = {
        findById: async () => ({
          branch_id: 'branch',
          created_by: 'user',
          model_config: { model: 'gemini-3.8-flash' },
        }),
      };
      const branches = { findById: async () => ({ path: workspace }) };
      const messages = { getNextIndexBySessionId: async () => 1 };
      for (const failWrite of [false, true]) {
        failReportWrite = failWrite;
        const service = new GeminiPromptService(
          messages as never,
          sessions as never,
          'offline-not-a-real-key',
          branches as never,
          undefined,
          undefined,
          undefined,
          false
        );
        await assert.rejects(
          async () => {
            for await (const _event of service.promptSessionStreaming(
              `error-${failWrite}` as never,
              'HOSTILE_PROMPT',
              undefined,
              'autoEdit'
            )) {
              /* consume */
            }
          },
          { message: 'Gemini rejected the API key. Check it in Settings → Gemini.' }
        );
      }
      // Cancellation crosses the real SDK stream boundary, not a mocked event enum.
      const stopped = new AbortController();
      G.Config.prototype.refreshAuth = async function (...args) {
        await originalAuth.apply(this, args);
        this.getContentGenerator().generateContentStream = async () =>
          (async function* () {
            stopped.abort();
            yield { candidates: [{ content: { role: 'model', parts: [{ text: 'cancelled' }] } }] };
          })();
      };
      const stopService = new GeminiPromptService(
        messages as never,
        sessions as never,
        'offline-not-a-real-key',
        branches as never,
        undefined,
        undefined,
        undefined,
        false
      );
      const stopEvents = [];
      for await (const event of stopService.promptSessionStreaming(
        'cancelled-session' as never,
        'stop fixture',
        undefined,
        'autoEdit',
        undefined,
        stopped.signal
      ))
        stopEvents.push(event);
      assert.ok(stopEvents.some((event) => event.type === 'stopped'));
    } finally {
      G.Config.prototype.refreshAuth = originalAuth;
      G.Config.prototype.getMaxAttempts = originalAttempts;
    }
    await ae.dispose();
    await yolo.dispose();
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url), '--resume-child'],
      {
        env: { ...process.env, GEMINI_CONTRACT_ROOT: root, TSX_DISABLE_CACHE: '1' },
        encoding: 'utf8',
        timeout: 60000,
      }
    );
    assert.equal(child.status, 0, `Cross-process resume failed: ${child.stderr}`);
  }
  await cleanup();
  cleanup = undefined;
  assert.equal(await fs.stat(temp).catch(() => null), null);
  assert.ok(
    !/HOSTILE_PROVIDER_BODY|HOSTILE_PROMPT|HOSTILE_PROVIDER_KEY/.test(JSON.stringify(capturedLogs)),
    'Private marker reached SDK logs'
  );
  const debugLog = await fs.readFile(debugFile, 'utf8').catch(() => '');
  assert.doesNotMatch(debugLog, /HOSTILE_PROVIDER_BODY|HOSTILE_PROMPT|HOSTILE_PROVIDER_KEY/);
  for (const entry of await fs.readdir(process.env.HOME!, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const content = await fs.readFile(path.join(entry.parentPath, entry.name), 'utf8');
    assert.ok(
      !/offline-not-a-real-key|HOSTILE_PROVIDER_KEY/.test(content),
      'Credential marker found in SDK home'
    );
  }
  const taskTemps = await fs.readdir(path.join(process.env.HOME!, '.gemini', 'agor-task-tmp'));
  assert.equal(taskTemps.filter((name) => name.startsWith(`${process.pid}-`)).length, 0);
} finally {
  Object.assign(console, originalConsole);
  G.Config.prototype.startMemoryService = originalMemory;
  await cleanup?.();
  if (!process.argv.includes('--resume-child')) await fs.rm(root, { recursive: true, force: true });
}
console.log('Gemini offline SDK contract passed');
