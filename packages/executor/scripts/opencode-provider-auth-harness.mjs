#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const originalEnvironment = { ...process.env };
const root = await mkdtemp(join(tmpdir(), 'agor-opencode-auth-'));
const strictQaArgument = process.argv.indexOf('--strict-qa-data-home');
const strictQaDataHome = strictQaArgument === -1 ? undefined : process.argv[strictQaArgument + 1];
assert(
  strictQaArgument === -1 || (strictQaDataHome && isAbsolute(strictQaDataHome)),
  '--strict-qa-data-home requires an absolute path'
);
const dataHome = strictQaDataHome ?? join(root, 'opaque-namespace');
const branchDirectory = join(root, 'branch-worktree');
const synthetic = {
  kimi: 'agor-synthetic-kimi-not-a-real-key',
  glm: 'agor-synthetic-glm-not-a-real-key',
  oauth: 'agor-synthetic-oauth-not-a-real-key',
  code: 'agor-synthetic-one-time-code',
  oauthCode: 'agor-synthetic-code-oauth-not-a-real-key',
};
let loopback;

function sanitizeEnvironment() {
  const keep = new Set(['PATH', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE']);
  for (const key of Object.keys(process.env)) {
    if (!keep.has(key)) delete process.env[key];
  }
  process.env.HOME = join(root, 'home');
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.XDG_CACHE_HOME = join(root, 'cache');
  process.env.NO_PROXY = '127.0.0.1,localhost';
  process.env.no_proxy = process.env.NO_PROXY;
  process.env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
}

function payload(params) {
  return { command: 'opencode.auth', dataHome, params };
}

async function expectSuccess(result) {
  assert.equal(result.success, true, JSON.stringify(result.error));
  return result.data;
}

try {
  sanitizeEnvironment();
  await mkdir(branchDirectory, { recursive: true });
  const loopbackCalls = [];
  loopback = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      loopbackCalls.push({
        path: request.url,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => loopback.listen(0, '127.0.0.1', resolve));
  const address = loopback.address();
  assert(address && typeof address === 'object');
  const loopbackOrigin = `http://127.0.0.1:${address.port}`;
  const pluginPath = join(root, 'synthetic-oauth-plugin.mjs');
  await writeFile(
    pluginPath,
    `
export async function SyntheticOAuthPlugin() {
  return {
    auth: {
      provider: "openai",
      loader: async () => ({}),
      methods: [{
        type: "oauth",
        label: "Synthetic headless",
        prompts: [
          {
            type: "select",
            key: "region",
            message: "Region",
            options: [{ label: "Loopback", value: "loopback" }]
          },
          {
            type: "text",
            key: "account",
            message: "Account",
            when: { key: "region", op: "eq", value: "loopback" }
          }
        ],
        authorize: async (inputs) => {
          await fetch(${JSON.stringify(`${loopbackOrigin}/authorize`)}, {
            method: "POST",
            body: JSON.stringify(inputs)
          })
          return {
            url: ${JSON.stringify(`${loopbackOrigin}/consent`)},
            method: "auto",
            instructions: "Complete synthetic loopback authorization.",
            callback: async () => {
              await fetch(${JSON.stringify(`${loopbackOrigin}/callback`)}, { method: "POST" })
              return { type: "success", key: ${JSON.stringify(synthetic.oauth)} }
            }
          }
        }
      }, {
        type: "oauth",
        label: "Synthetic denial",
        authorize: async () => ({
          url: ${JSON.stringify(`${loopbackOrigin}/denied-consent`)},
          method: "auto",
          instructions: "Deny the synthetic authorization.",
          callback: async () => ({ type: "failed" })
        })
      }, {
        type: "oauth",
        label: "Synthetic code",
        authorize: async () => ({
          url: ${JSON.stringify(`${loopbackOrigin}/code-consent`)},
          method: "code",
          instructions: "Paste the synthetic one-time code.",
          callback: async (code) => {
            await fetch(${JSON.stringify(`${loopbackOrigin}/code-callback`)}, {
              method: "POST",
              body: code
            })
            return code === ${JSON.stringify(synthetic.code)}
              ? { type: "success", key: ${JSON.stringify(synthetic.oauthCode)} }
              : { type: "failed" }
          }
        })
      }]
    }
  }
}
`,
    { mode: 0o600 }
  );
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    plugin: [pathToFileURL(pluginPath).href],
  });

  const { handleOpenCodeAuth, handleOpenCodeOAuth } = await import(
    '../src/commands/opencode-auth.ts'
  );
  const { startManagedOpenCodeServer } = await import(
    '../src/sdk-handlers/opencode/managed-server.ts'
  );
  const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
  const discovered = await expectSuccess(
    await handleOpenCodeAuth(payload({ operation: 'discover' }), {})
  );
  const findProvider = (pattern) =>
    discovered.providers.find((provider) => pattern.test(`${provider.id} ${provider.name}`));
  const kimi = findProvider(/kimi|moonshot/i);
  const glm = findProvider(/glm|zhipu/i);
  const oauth = discovered.providers.find((provider) => provider.id === 'openai');
  assert(kimi, 'The packaged OpenCode catalog did not expose a Kimi/Moonshot provider');
  assert(glm, 'The packaged OpenCode catalog did not expose a GLM/Zhipu provider');
  assert(oauth, 'The OpenAI provider was not loaded by pinned OpenCode');
  assert.deepEqual(oauth.authMethods, [
    {
      index: 0,
      type: 'oauth',
      label: 'Synthetic headless',
      prompts: [
        {
          type: 'select',
          key: 'region',
          message: 'Region',
          options: [{ label: 'Loopback', value: 'loopback' }],
        },
        {
          type: 'text',
          key: 'account',
          message: 'Account',
          when: { key: 'region', op: 'eq', value: 'loopback' },
        },
      ],
    },
    {
      index: 1,
      type: 'oauth',
      label: 'Synthetic denial',
    },
    {
      index: 2,
      type: 'oauth',
      label: 'Synthetic code',
    },
  ]);

  const oauthEvents = [];
  const oauthConnected = await expectSuccess(
    await handleOpenCodeOAuth(
      payload({
        operation: 'connect-oauth',
        providerId: oauth.id,
        method: oauth.authMethods[0].index,
        inputs: { region: 'loopback', account: 'synthetic-account' },
      }),
      {},
      (event) => oauthEvents.push(event)
    )
  );
  assert.deepEqual(
    oauthEvents.map((event) => event.type),
    ['authorized', 'callback-started']
  );
  assert.equal(
    oauthConnected.providers.find((provider) => provider.id === oauth.id)?.configured,
    true
  );
  assert.deepEqual(
    loopbackCalls.map((call) => call.path),
    ['/authorize', '/callback']
  );
  assert.match(loopbackCalls[0].body, /synthetic-account/);

  const denied = await handleOpenCodeOAuth(
    payload({
      operation: 'connect-oauth',
      providerId: oauth.id,
      method: 1,
    }),
    {},
    () => undefined
  );
  assert.equal(denied.success, false);
  const afterDenial = await expectSuccess(
    await handleOpenCodeAuth(payload({ operation: 'discover' }), {})
  );
  assert.equal(
    afterDenial.providers.find((provider) => provider.id === oauth.id)?.configured,
    true,
    'native failed callback must preserve the prior configured connection'
  );

  const codeEvents = [];
  const codeConnected = await expectSuccess(
    await handleOpenCodeOAuth(
      payload({
        operation: 'connect-oauth',
        providerId: oauth.id,
        method: 2,
      }),
      {},
      (event) => codeEvents.push(event),
      async () => synthetic.code
    )
  );
  assert.deepEqual(
    codeEvents.map((event) => event.type),
    ['authorized', 'callback-started']
  );
  assert.equal(
    codeConnected.providers.find((provider) => provider.id === oauth.id)?.configured,
    true
  );
  assert.equal(loopbackCalls.at(-1)?.path, '/code-callback');
  assert.equal(loopbackCalls.at(-1)?.body, synthetic.code);

  const kimiConnected = await expectSuccess(
    await handleOpenCodeAuth(
      payload({
        operation: 'connect-api-key',
        providerId: kimi.id,
        apiKey: synthetic.kimi,
      }),
      {}
    )
  );
  assert.equal(
    kimiConnected.providers.find((provider) => provider.id === kimi.id)?.configured,
    true
  );

  const glmConnected = await expectSuccess(
    await handleOpenCodeAuth(
      payload({
        operation: 'connect-api-key',
        providerId: glm.id,
        apiKey: synthetic.glm,
      }),
      {}
    )
  );
  assert.equal(glmConnected.providers.find((provider) => provider.id === glm.id)?.configured, true);
  assert.equal((await stat(join(dataHome, 'opencode', 'auth.json'))).mode & 0o777, 0o600);

  const taskServer = await startManagedOpenCodeServer({
    directory: branchDirectory,
    dataHome,
    secrets: Object.values(synthetic),
  });
  const taskClient = createOpencodeClient({
    baseUrl: taskServer.baseUrl,
    directory: branchDirectory,
    headers: { Authorization: taskServer.authorization },
  });
  let taskProviderResponse;
  try {
    taskProviderResponse = await taskClient.provider.list({ directory: branchDirectory });
    assert.equal(taskProviderResponse.error, undefined);
    assert(taskProviderResponse.data?.connected.includes(kimi.id));
    assert(taskProviderResponse.data?.connected.includes(glm.id));
    await taskClient.instance.dispose({ directory: branchDirectory });
  } finally {
    await taskServer.close();
  }

  if (!strictQaDataHome) {
    for (const provider of [oauth, kimi, glm]) {
      const disconnected = await expectSuccess(
        await handleOpenCodeAuth(payload({ operation: 'disconnect', providerId: provider.id }), {})
      );
      assert.equal(
        disconnected.providers.find((candidate) => candidate.id === provider.id)?.configured,
        false
      );
    }
  }

  const evidence = JSON.stringify({
    runtimeVersion: discovered.runtimeVersion,
    providers: ['openai', 'kimi-or-moonshot', 'glm-or-zhipu'],
    oauthAuthorizeCallbackSameRuntime: true,
    oauthLoopbackTransitions: oauthEvents.map((event) => event.type),
    oauthCodeTransitions: codeEvents.map((event) => event.type),
    nativeFailurePreservesPriorConnection: true,
    boundedCodeCallback: true,
    oauthFreshDisconnect: !strictQaDataHome,
    freshStatusAfterMutation: true,
    freshTaskShapedRead: true,
    authMode: '0600',
    syntheticOnly: true,
    strictQaFixtureRetained: Boolean(strictQaDataHome),
  });
  assert(!evidence.includes(root));
  assert(!evidence.includes(synthetic.kimi));
  assert(!evidence.includes(synthetic.glm));
  assert(!evidence.includes(synthetic.oauth));
  console.log(evidence);
} finally {
  if (loopback?.listening) await new Promise((resolve) => loopback.close(resolve));
  process.env = originalEnvironment;
  await rm(root, { recursive: true, force: true });
}
