#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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
};

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
  const { handleOpenCodeAuth } = await import('../src/commands/opencode-auth.ts');
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
  assert(kimi, 'The packaged OpenCode catalog did not expose a Kimi/Moonshot provider');
  assert(glm, 'The packaged OpenCode catalog did not expose a GLM/Zhipu provider');

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
    for (const provider of [kimi, glm]) {
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
    providers: [kimi.id, glm.id],
    freshStatusAfterMutation: true,
    freshTaskShapedRead: true,
    authMode: '0600',
    syntheticOnly: true,
    strictQaFixtureRetained: Boolean(strictQaDataHome),
  });
  assert(!evidence.includes(root));
  assert(!evidence.includes(synthetic.kimi));
  assert(!evidence.includes(synthetic.glm));
  console.log(evidence);
} finally {
  process.env = originalEnvironment;
  await rm(root, { recursive: true, force: true });
}
