#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Console } from 'node:console';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function requestStatusWithRetry(url, init, attempts = 20) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, init);
      const status = response.status;
      await response.body?.cancel();
      return status;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await delay(25);
    }
  }
  throw lastError;
}

async function requestIsDenied(url, init) {
  try {
    return (await requestStatusWithRetry(url, init, 1)) === 401;
  } catch {
    // OpenCode may reject invalid Basic auth by resetting the connection.
    return true;
  }
}

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const modulePath = resolve(args.get('--module') ?? 'src/sdk-handlers/opencode/opencode-tool.ts');
const permissionModulePath = resolve(
  args.get('--permission-module') ?? 'src/permissions/permission-service.ts'
);
const streamingModulePath = resolve(
  args.get('--streaming-module') ?? 'src/handlers/sdk/base-executor.ts'
);
const containmentModulePath = resolve(
  args.get('--containment-module') ?? '../../apps/agor-daemon/src/executor-tracking.ts'
);

const originalEnvironment = { ...process.env };
const root = await mkdtemp(join(tmpdir(), 'agor-opencode-runtime-'));
const childRecords = [];
const controllers = new Set();
let sequence = 1;
let cleanupPromise;

function id() {
  return `00000000-0000-7000-8000-${String(sequence++).padStart(12, '0')}`;
}

function cleanup() {
  cleanupPromise ??= (async () => {
    for (const controller of controllers) controller.abort('Harness cleanup');
    for (const record of childRecords) {
      if (record.pid && processExists(record.pid)) {
        try {
          process.kill(record.pid, 'SIGKILL');
        } catch {}
      }
    }
    process.env = originalEnvironment;
    await rm(root, { recursive: true, force: true });
  })();
  return cleanupPromise;
}

for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(exitCode));
  });
}

function sanitizeEnvironment() {
  const keep = new Set(['PATH', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE']);
  for (const key of Object.keys(process.env)) {
    if (!keep.has(key)) delete process.env[key];
  }
  process.env.HOME = join(root, 'home');
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.XDG_DATA_HOME = join(root, 'data');
  process.env.XDG_CACHE_HOME = join(root, 'cache');
  process.env.NO_PROXY = '127.0.0.1,localhost';
  process.env.no_proxy = process.env.NO_PROXY;
}

async function listen(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    port: address.port,
    async close() {
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : undefined;
}

function writeChunk(response, delta, finishReason = null, usage) {
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-${sequence++}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'proof-model',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    })}\n\n`
  );
}

function currentTurn(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') {
      userIndex = index;
      break;
    }
  }
  return {
    prompt: String(messages[userIndex]?.content ?? ''),
    toolResults: messages.slice(userIndex + 1).filter((message) => message?.role === 'tool'),
    messages,
  };
}

function createProvider() {
  const keys = new Map();
  const failures = new Map();
  const requests = [];
  const errors = [];
  const waitingScenarios = new Map();
  let concurrentCount = 0;
  let resolveConcurrentReady;
  let releaseConcurrent;
  const concurrentReady = new Promise((resolveReady) => (resolveConcurrentReady = resolveReady));
  const concurrentGate = new Promise((resolveGate) => (releaseConcurrent = resolveGate));
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readJson(request);
      const authorization = request.headers.authorization;
      const label = keys.get(authorization);
      if (!label) {
        response.writeHead(401).end();
        return;
      }
      const turn = currentTurn(body);
      const entry = {
        at: Date.now(),
        endedAt: undefined,
        label,
        prompt: turn.prompt,
        affinity: request.headers['x-session-affinity'],
        body,
      };
      requests.push(entry);
      const secretFailure = turn.prompt === 'secret-failure';
      if (secretFailure && turn.toolResults.length > 0) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: failures.get(label)?.() ?? 'secret failure' } })
        );
        entry.endedAt = Date.now();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });

      if (turn.prompt.startsWith('concurrent:')) {
        concurrentCount++;
        if (concurrentCount === 2) resolveConcurrentReady();
        await concurrentGate;
      }

      if (turn.prompt === 'stop' || turn.prompt === 'watchdog') {
        writeChunk(response, { role: 'assistant', content: `${turn.prompt}-started` });
        waitingScenarios.get(turn.prompt)?.();
        return;
      }

      const permission = turn.prompt.startsWith('permission:');
      const primary = turn.prompt === 'primary';
      const needsTool = primary || permission || secretFailure;
      const requiredTools =
        permission &&
        !turn.prompt.endsWith(':deny') &&
        !turn.prompt.endsWith(':timeout') &&
        !turn.prompt.endsWith(':cancel')
          ? 2
          : 1;

      if (needsTool && turn.toolResults.length < requiredTools) {
        if ((primary || secretFailure) && turn.toolResults.length === 0) {
          writeChunk(response, { role: 'assistant', content: 'before ' });
          await delay(35);
          writeChunk(response, { content: 'tool' });
          await delay(35);
        }
        const command = permission ? `printf ${turn.prompt}` : 'printf tool-result';
        writeChunk(response, {
          tool_calls: [
            {
              index: 0,
              id: `call-${turn.toolResults.length + 1}-${sequence++}`,
              type: 'function',
              function: {
                name: 'bash',
                arguments: JSON.stringify({ command, description: 'Print proof marker' }),
              },
            },
          ],
        });
        writeChunk(response, {}, 'tool_calls', {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        });
        response.end('data: [DONE]\n\n');
        entry.endedAt = Date.now();
        return;
      }

      let parts;
      if (primary) parts = ['after ', 'tool'];
      else if (permission) parts = ['permission-', 'complete'];
      else if (turn.prompt.startsWith('concurrent:')) {
        const marker = turn.prompt.split(':')[1];
        parts = [`${marker}-one`, `${marker}-two`];
      } else if (turn.prompt === 'continuation') parts = ['continued-', 'after-restart'];
      else parts = ['simple-', 'complete'];
      writeChunk(response, { role: 'assistant', content: parts[0] });
      await delay(35);
      writeChunk(response, { content: parts[1] });
      writeChunk(response, {}, 'stop', {
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
      });
      response.end('data: [DONE]\n\n');
      entry.endedAt = Date.now();
    })().catch((error) => {
      errors.push(error);
      response.destroy(error);
    });
  });
  return {
    server,
    keys,
    failures,
    requests,
    errors,
    waitForScenario(name) {
      return new Promise((resolveWait) => waitingScenarios.set(name, resolveWait));
    },
    waitForConcurrent: () => concurrentReady,
    releaseConcurrent,
  };
}

function createMcp(secret) {
  const requests = [];
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readJson(request);
      requests.push({ at: Date.now(), authorization: request.headers.authorization, body });
      assert.equal(request.headers.authorization, `Bearer ${secret}`);
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      if (body?.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        body.method === 'initialize'
          ? {
              protocolVersion: body.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'agor-proof', version: '1' },
            }
          : body.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'proof_marker',
                    description: 'Return the deterministic proof marker',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              }
            : {};
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    })().catch((error) => response.destroy(error));
  });
  return { server, requests };
}

function processExists(pidOrGroup) {
  try {
    process.kill(pidOrGroup, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitAbsent(pidOrGroup, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pidOrGroup) && Date.now() < deadline) await delay(20);
  return !processExists(pidOrGroup);
}

function permissionDependencies(PermissionService, mode, controller) {
  const requests = [];
  const taskPatches = [];
  const sessionPatches = [];
  const messagePatches = [];
  const messages = [];
  let service;
  service = new PermissionService(async (event, data) => {
    if (event !== 'permission:request') return;
    requests.push(data);
    if (mode === 'timeout') return;
    if (mode === 'cancel') {
      setTimeout(() => controller.abort('User Stop'), 0);
      return;
    }
    setTimeout(
      () =>
        service.resolvePermission({
          requestId: data.requestId,
          taskId: data.taskId,
          allow: mode !== 'deny',
          remember: mode === 'remembered',
          scope: mode === 'remembered' ? 'project' : 'once',
          decidedBy: 'runtime-harness',
        }),
      0
    );
  }, 75);
  return {
    requests,
    taskPatches,
    sessionPatches,
    messagePatches,
    dependencies: {
      permissionService: service,
      messagesRepo: { findBySessionId: async () => messages },
      messagesService: {
        create: async (data) => {
          messages.push(data);
          return data;
        },
        patch: async (messageId, data) => {
          messagePatches.push({ messageId, data });
          return data;
        },
      },
      tasksService: {
        patch: async (taskId, data) => {
          taskPatches.push({ taskId, data });
          return data;
        },
      },
      sessionsService: {
        patch: async (sessionId, data) => {
          sessionPatches.push({ sessionId, data });
          return data;
        },
      },
      sessionMCPRepo: { listServers: async () => [] },
      mcpServerRepo: {},
    },
  };
}

async function run() {
  sanitizeEnvironment();
  await Promise.all(
    ['home', 'config', 'data', 'cache'].map((directory) =>
      mkdir(join(root, directory), { recursive: true })
    )
  );
  const [
    { OpenCodeTool, resolvePackagedOpenCodeBinary },
    { PermissionService },
    { createStreamingCallbacks },
    { containExecutorProcess, trackExecutorProcess, untrackExecutorProcess },
  ] = await Promise.all([
    import(pathToFileURL(modulePath).href),
    import(pathToFileURL(permissionModulePath).href),
    import(pathToFileURL(streamingModulePath).href),
    import(pathToFileURL(containmentModulePath).href),
  ]);
  const packagedBinary = await realpath(await resolvePackagedOpenCodeBinary());
  assert.match(packagedBinary, /opencode-ai[\\/]bin[\\/]\.opencode$/);

  const provider = createProvider();
  const providerListener = await listen(provider.server);
  const mcpSecret = 'mcp-managed-secret';
  const mcp = createMcp(mcpSecret);
  const mcpListener = await listen(mcp.server);
  process.env.DAEMON_URL = `http://127.0.0.1:${mcpListener.port}`;
  const allSecrets = [mcpSecret];
  const rows = [];

  const project = async (name) => {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    return directory;
  };
  const invocationConfig = (providerKey, includeMcp, askForBash) => ({
    model: 'agor-proof/proof-model',
    mcp: includeMcp
      ? {
          proof: {
            type: 'remote',
            url: `http://127.0.0.1:${mcpListener.port}/mcp`,
            enabled: true,
            headers: { Authorization: `Bearer ${mcpSecret}` },
          },
        }
      : {},
    permission: askForBash ? { bash: 'ask' } : { '*': 'allow' },
    provider: {
      'agor-proof': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Agor Proof',
        options: {
          baseURL: `http://127.0.0.1:${providerListener.port}/v1`,
          apiKey: providerKey,
        },
        models: { 'proof-model': { name: 'Proof Model' } },
      },
    },
  });

  function createTool(label, options = {}) {
    const providerKey = `provider-managed-secret-${label}`;
    const authorization = `Bearer ${providerKey}`;
    provider.keys.set(authorization, label);
    allSecrets.push(providerKey);
    const record = {
      label,
      output: '',
      executable: undefined,
      pid: undefined,
      baseUrl: undefined,
      password: undefined,
      authProbe: undefined,
    };
    childRecords.push(record);
    const seed = childRecords.length;
    if (options.useProductionConfig) {
      process.env.PROOF_PROVIDER_API_KEY = providerKey;
      process.env.AGOR_USER_ENV_KEYS = 'PROOF_PROVIDER_API_KEY';
    }
    const toolDependencies = {
      ...options.permissionDependencies,
      randomBytes: () => Buffer.alloc(32, seed),
      spawn: (executable, executableArgs, spawnOptions) => {
        record.executable = executable;
        record.password = spawnOptions.env.OPENCODE_SERVER_PASSWORD;
        allSecrets.push(record.password);
        const child = spawn(executable, [...executableArgs], spawnOptions);
        record.pid = child.pid;
        const capture = (chunk) => {
          record.output = `${record.output}${chunk.toString()}`.slice(-16_384);
          const match = record.output.match(
            /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/
          );
          if (!match || record.baseUrl) return;
          record.baseUrl = match[1];
          const correct = `Basic ${Buffer.from(`agor:${record.password}`).toString('base64')}`;
          record.authProbe = Promise.all([
            requestIsDenied(`${record.baseUrl}/global/health`),
            requestIsDenied(`${record.baseUrl}/global/health`, {
              headers: { Authorization: 'Basic d3Jvbmc6d3Jvbmc=' },
            }),
            requestStatusWithRetry(`${record.baseUrl}/global/health`, {
              headers: { Authorization: correct },
            }),
          ]);
        };
        child.stdout?.on('data', capture);
        child.stderr?.on('data', capture);
        return child;
      },
      readinessTimeoutMs: 15_000,
      shutdownTimeoutMs: 2_000,
      eventDrainMs: 20,
    };
    if (options.useProductionConfig) {
      toolDependencies.sessionMCPRepo = {
        listEffectiveServers: async () =>
          options.includeMcp
            ? [
                {
                  mcp_server_id: id(),
                  name: 'proof',
                  transport: 'http',
                  url: `http://127.0.0.1:${mcpListener.port}/mcp`,
                  headers: { Authorization: `Bearer ${mcpSecret}` },
                  scope: 'session',
                  enabled: true,
                },
              ]
            : [],
      };
      toolDependencies.mcpServerRepo = {};
    } else {
      toolDependencies.resolveInvocationConfig = async () =>
        invocationConfig(providerKey, options.includeMcp, options.askForBash);
    }
    const tool = new OpenCodeTool(toolDependencies);
    return { tool, record };
  }

  async function execute(label, options = {}) {
    const controller = options.controller ?? new AbortController();
    controllers.add(controller);
    const defaultPermission = options.permissionDependencies
      ? undefined
      : permissionDependencies(PermissionService, 'once', controller);
    const { tool, record } = createTool(label, {
      ...options,
      permissionDependencies: options.permissionDependencies ?? defaultPermission.dependencies,
    });
    if (options.secretFailure) {
      provider.failures.set(label, () =>
        [
          record.password,
          `provider-managed-secret-${label}`,
          mcpSecret,
          JSON.stringify(invocationConfig(`provider-managed-secret-${label}`, true, false)),
        ].join(' :: ')
      );
    }
    const streamed = [];
    const persisted = [];
    const input = {
      agorSessionId: options.agorSessionId ?? id(),
      taskId: id(),
      agorAssistantMessageId: id(),
      prompt: options.prompt ?? label,
      title: label,
      directory: options.directory,
      ...(options.missingPair
        ? {}
        : {
            provider: options.provider ?? 'agor-proof',
            model: options.model ?? 'proof-model',
          }),
      existingOpenCodeSessionId: options.existingOpenCodeSessionId,
      mcpToken: mcpSecret,
      permissionMode:
        options.permissionMode ??
        (options.permissionDependencies ? 'default' : 'bypassPermissions'),
      signal: controller.signal,
      persistOpenCodeSessionId: async (sessionId) => persisted.push(sessionId),
    };
    const promise = tool.runTurn(
      input,
      options.streamingCallbacks ?? {
        onStreamStart: async () => {},
        onStreamChunk: async (_messageId, chunk) => streamed.push({ chunk, at: Date.now() }),
        onStreamEnd: async () => {},
        onStreamError: async () => {},
      }
    );
    return { controller, input, persisted, promise, record, streamed };
  }

  const mainDirectory = await project('main-project');
  const main = await execute('primary', {
    prompt: 'primary',
    directory: mainDirectory,
    includeMcp: true,
  });
  const mainResult = await main.promise;
  assert.deepEqual(await main.record.authProbe, [true, true, 200]);
  assert.equal(main.record.executable, packagedBinary);
  assert(main.record.pid && (await waitAbsent(main.record.pid)));
  assert.deepEqual(mainResult.finalMessage.contentBlocks, [
    { type: 'text', text: 'before tool' },
    {
      type: 'tool_use',
      id: mainResult.finalMessage.toolUses[0].id,
      name: 'bash',
      input: { command: 'printf tool-result', description: 'Print proof marker' },
    },
    {
      type: 'tool_result',
      tool_use_id: mainResult.finalMessage.toolUses[0].id,
      content: 'tool-result',
    },
    { type: 'text', text: 'after tool' },
  ]);
  const primaryRequests = provider.requests.filter((request) => request.prompt === 'primary');
  assert(main.streamed.length >= 4);
  assert(main.streamed.slice(0, 2).every((delta) => delta.at < primaryRequests.at(-1).endedAt));
  const toolsList = mcp.requests.find((request) => request.body?.method === 'tools/list');
  assert(toolsList && toolsList.at <= primaryRequests[0].at);
  assert(
    primaryRequests[0].body.tools.some((tool) => tool.function?.name === 'proof_proof_marker')
  );
  rows.push(
    ['packaged-startup-auth', 'pass'],
    ['incremental-streaming', 'pass'],
    ['text-tool-text-transcript', 'pass'],
    ['mcp-before-prompt', 'pass']
  );

  const missingPair = await execute('missing-pair', {
    prompt: 'missing-pair',
    directory: await project('missing-pair'),
    missingPair: true,
  });
  await assert.rejects(missingPair.promise, /Select an exact OpenCode provider and model/);
  assert.equal(missingPair.record.executable, undefined);
  assert.equal(missingPair.persisted.length, 0);
  assert(!provider.requests.some((request) => request.label === 'missing-pair'));
  rows.push(['missing-exact-pair-before-start', 'pass']);

  const permissiveDirectory = await project('permissive-project');
  const permissiveProviderKey = 'provider-managed-secret-production-config';
  await writeFile(
    join(permissiveDirectory, 'opencode.json'),
    JSON.stringify({
      permission: { '*': 'allow', bash: 'allow', edit: 'allow' },
      agent: {
        build: { permission: { '*': 'allow', bash: 'allow', edit: 'allow' } },
      },
      provider: {
        'agor-proof': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Agor Proof',
          options: {
            baseURL: `http://127.0.0.1:${providerListener.port}/v1`,
            apiKey: permissiveProviderKey,
          },
          models: { 'proof-model': { name: 'Proof Model' } },
        },
      },
    })
  );
  const restrictiveController = new AbortController();
  const restrictivePermission = permissionDependencies(
    PermissionService,
    'once',
    restrictiveController
  );
  const restrictive = await execute('production-config', {
    prompt: 'permission:production-config',
    directory: permissiveDirectory,
    controller: restrictiveController,
    permissionMode: 'default',
    permissionDependencies: restrictivePermission.dependencies,
    useProductionConfig: true,
    includeMcp: true,
  });
  await restrictive.promise;
  assert.equal(restrictivePermission.requests.length, 2);
  rows.push(['production-config-forces-permission-interception', 'pass']);

  const continued = await execute('continuation', {
    prompt: 'continuation',
    directory: mainDirectory,
    existingOpenCodeSessionId: mainResult.openCodeSessionId,
  });
  const continuedResult = await continued.promise;
  assert.equal(continuedResult.openCodeSessionId, mainResult.openCodeSessionId);
  assert.equal(continuedResult.sessionWasCreated, false);
  assert.equal(continued.persisted.length, 0);
  assert.notEqual(continued.record.pid, main.record.pid);
  assert.equal(continuedResult.finalMessage.content, 'continued-after-restart');
  const continuationRequest = provider.requests.find(
    (request) => request.prompt === 'continuation'
  );
  assert(continuationRequest.body.messages.some((message) => message.content === 'primary'));
  rows.push(['session-continuation-after-restart', 'pass']);

  const concurrentDirectoryA = await project('concurrent-a');
  const concurrentDirectoryB = await project('concurrent-b');
  const concurrentA = await execute('concurrent-a', {
    prompt: 'concurrent:A',
    directory: concurrentDirectoryA,
  });
  const concurrentB = await execute('concurrent-b', {
    prompt: 'concurrent:B',
    directory: concurrentDirectoryB,
  });
  await provider.waitForConcurrent();
  const wrongA = `Basic ${Buffer.from(`agor:${concurrentA.record.password}`).toString('base64')}`;
  assert.equal(
    await requestIsDenied(`${concurrentB.record.baseUrl}/global/health`, {
      headers: { Authorization: wrongA },
    }),
    true
  );
  provider.releaseConcurrent();
  const [resultA, resultB] = await Promise.all([concurrentA.promise, concurrentB.promise]);
  assert.notEqual(concurrentA.record.baseUrl, concurrentB.record.baseUrl);
  assert.notEqual(resultA.openCodeSessionId, resultB.openCodeSessionId);
  assert.equal(resultA.finalMessage.content, 'A-oneA-two');
  assert.equal(resultB.finalMessage.content, 'B-oneB-two');
  assert(concurrentA.streamed.every((entry) => !entry.chunk.includes('B-')));
  assert(concurrentB.streamed.every((entry) => !entry.chunk.includes('A-')));
  for (const [label, result] of [
    ['concurrent-a', resultA],
    ['concurrent-b', resultB],
  ]) {
    const requests = provider.requests.filter((request) => request.label === label);
    assert(requests.every((request) => request.affinity === result.openCodeSessionId));
  }
  rows.push(['concurrent-isolation', 'pass']);

  for (const mode of ['once', 'remembered', 'deny', 'timeout', 'cancel']) {
    const controller = new AbortController();
    const permission = permissionDependencies(PermissionService, mode, controller);
    const turn = await execute(`permission-${mode}`, {
      prompt: `permission:${mode}`,
      directory: await project(`permission-${mode}`),
      controller,
      askForBash: true,
      permissionDependencies: permission.dependencies,
    });
    if (mode === 'once' || mode === 'remembered') {
      const result = await turn.promise;
      assert.equal(result.finalMessage.content, 'permission-complete');
      assert.equal(permission.requests.length, mode === 'once' ? 2 : 1);
      assert(permission.messagePatches.every((patch) => patch.data.content.status === 'approved'));
    } else {
      await assert.rejects(turn.promise, /permission was rejected|turn was aborted|User Stop/i);
      assert.equal(permission.requests.length, 1);
      if (mode === 'timeout') {
        assert(
          permission.messagePatches.some((patch) => patch.data.content.status === 'timed_out')
        );
        assert(permission.taskPatches.some((patch) => patch.data.status === 'timed_out'));
      }
    }
  }
  rows.push(['permission-matrix', 'pass']);

  const stopStarted = provider.waitForScenario('stop');
  const stop = await execute('stop', {
    prompt: 'stop',
    directory: await project('stop'),
  });
  await stopStarted;
  stop.controller.abort('User Stop');
  await assert.rejects(stop.promise, /aborted|fetch failed|User Stop/i);
  assert(stop.record.pid && (await waitAbsent(stop.record.pid)));
  rows.push(['stop-cleanup', 'pass']);

  if (process.platform === 'linux' || process.platform === 'darwin') {
    const watchdogStarted = provider.waitForScenario('watchdog');
    const providerKey = 'provider-managed-secret-watchdog';
    provider.keys.set(`Bearer ${providerKey}`, 'watchdog');
    allSecrets.push(providerKey);
    const script = `
      import { spawn } from 'node:child_process';
      const { OpenCodeTool } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
      const tool = new OpenCodeTool({
        resolveInvocationConfig: async () => (${JSON.stringify(
          invocationConfig(providerKey, false, false)
        )}),
        randomBytes: () => Buffer.alloc(32, 91),
        spawn: (executable, args, options) => {
          const child = spawn(executable, [...args], options);
          process.send?.({ serverPid: child.pid });
          return child;
        },
        readinessTimeoutMs: 15000,
        shutdownTimeoutMs: 2000,
      });
      await tool.runTurn({
        agorSessionId: ${JSON.stringify(id())}, taskId: ${JSON.stringify(id())},
        agorAssistantMessageId: ${JSON.stringify(id())}, prompt: 'watchdog', title: 'watchdog',
        directory: ${JSON.stringify(await project('watchdog'))}, provider: 'agor-proof',
        model: 'proof-model', signal: new AbortController().signal,
        persistOpenCodeSessionId: async () => {},
      });
    `;
    const leader = spawn(
      process.execPath,
      [...process.execArgv, '--input-type=module', '--eval', script],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env },
      }
    );
    let serverPid;
    leader.on('message', (message) => {
      if (message?.serverPid) serverPid = message.serverPid;
    });
    let watchdogDiagnostic = '';
    leader.stderr.on('data', (chunk) => {
      watchdogDiagnostic += chunk.toString();
    });
    await Promise.race([
      watchdogStarted,
      new Promise((_, reject) =>
        leader.once('exit', (code, signal) =>
          reject(
            new Error(
              `Watchdog executor exited before provider startup (code ${code}, signal ${signal}): ${watchdogDiagnostic}`
            )
          )
        )
      ),
    ]);
    assert(leader.pid && serverPid);
    const watchdogSessionId = id();
    const watchdogTaskId = id();
    trackExecutorProcess({
      sessionId: watchdogSessionId,
      taskId: watchdogTaskId,
      pid: leader.pid,
    });
    const containment = await containExecutorProcess(watchdogSessionId, watchdogTaskId, {
      termGraceMs: 2_000,
      killGraceMs: 2_000,
      pollMs: 20,
    });
    untrackExecutorProcess(watchdogSessionId, watchdogTaskId);
    assert.deepEqual(containment, { status: 'verified_absent' });
    assert(await waitAbsent(-leader.pid));
    assert(await waitAbsent(serverPid));
    childRecords.push({ label: 'watchdog', output: watchdogDiagnostic });
    rows.push(['daemon-process-group-containment', 'pass']);
  } else {
    rows.push(['daemon-process-group-containment', 'blocked: unsupported platform']);
  }

  const invalidProviderCount = provider.requests.length;
  const invalid = await execute('invalid-session', {
    prompt: 'invalid-session',
    directory: await project('invalid-session'),
    existingOpenCodeSessionId: 'ses_missing_runtime_proof',
  });
  await assert.rejects(invalid.promise, /Unable to resume stored OpenCode session/);
  assert.equal(invalid.persisted.length, 0);
  assert.equal(provider.requests.length, invalidProviderCount);
  rows.push(['invalid-session-no-replacement', 'pass']);

  const invalidPairProviderCount = provider.requests.length;
  const invalidPair = await execute('invalid-explicit-pair', {
    prompt: 'invalid-explicit-pair',
    directory: await project('invalid-explicit-pair'),
    provider: 'agor-missing',
    model: 'missing-model',
  });
  await assert.rejects(invalidPair.promise, /selected OpenCode provider\/model is not available/);
  assert.equal(invalidPair.persisted.length, 0);
  assert.equal(provider.requests.length, invalidPairProviderCount);
  assert(invalidPair.record.pid && (await waitAbsent(invalidPair.record.pid)));
  rows.push(['invalid-explicit-pair-before-provider', 'pass']);

  const broadcastEvents = [];
  const loggerEvents = [];
  const applicationClient = {
    service(name) {
      assert.equal(name, '/messages/streaming');
      return { create: async (event) => broadcastEvents.push(event) };
    },
  };
  const applicationCallbacks = createStreamingCallbacks(applicationClient, 'opencode', id());
  const originalConsoleError = console.error;
  const loggerStream = new Writable({
    write(chunk, _encoding, callback) {
      loggerEvents.push(chunk.toString());
      callback();
    },
  });
  const productionConsole = new Console({
    stdout: loggerStream,
    stderr: loggerStream,
    colorMode: false,
  });
  console.error = productionConsole.error.bind(productionConsole);
  try {
    const failure = await execute('secret-failure', {
      prompt: 'secret-failure',
      directory: await project('secret-failure'),
      includeMcp: true,
      streamingCallbacks: applicationCallbacks,
      secretFailure: true,
    });
    await assert.rejects(failure.promise, /REDACTED/);
  } finally {
    console.error = originalConsoleError;
  }
  assert(loggerEvents.join('').includes('[opencode] Stream error'));
  assert(broadcastEvents.some((event) => event.event === 'streaming:error'));
  const applicationDiagnostics = JSON.stringify({ broadcastEvents, loggerEvents });
  for (const secret of allSecrets) assert(!applicationDiagnostics.includes(secret));
  rows.push(['post-readiness-application-redaction', 'pass']);

  assert.equal(provider.errors.length, 0);
  const diagnostics = childRecords.map((record) => record.output ?? '').join('\n');
  for (const secret of allSecrets) assert(!diagnostics.includes(secret));
  rows.push(['successful-child-output-secret-scan', 'pass']);

  for (const record of childRecords) {
    if (record.pid) assert(await waitAbsent(record.pid));
  }
  await providerListener.close();
  await mcpListener.close();
  return { packagedBinary, rows };
}

try {
  const result = await run();
  console.log(JSON.stringify({ status: 'pass', platform: process.platform, ...result }, null, 2));
} finally {
  await cleanup();
}
