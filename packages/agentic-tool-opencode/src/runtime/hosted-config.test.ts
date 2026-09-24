import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertOpenCodeBinaryCompatibility } from './binary.js';
import {
  assertHostedOpenCodeInvocationConfig,
  hostedOpenCodeEnvironment,
} from './hosted-config.js';
import { startManagedOpenCodeServer } from './managed-server.js';
import { prepareOpenCodeScratch, resolveOpenCodeNativeStateLayout } from './native-state.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('rejects excluded invocation configuration before starting a credentialed server', () => {
  for (const config of [
    { mcp: {}, plugin: [] },
    { mcp: {}, provider: { openai: { options: { baseURL: 'https://example.invalid' } } } },
    { mcp: { command: { type: 'local', command: ['true'], enabled: false } } },
  ])
    expect(() => assertHostedOpenCodeInvocationConfig(config)).toThrow(/Hosted OpenCode/);
  expect(() =>
    assertHostedOpenCodeInvocationConfig({
      mcp: { managed: { type: 'remote', url: 'https://example.invalid/mcp' } },
    })
  ).not.toThrow();
});

it('seals selectors without changing the execution HOME or unrelated tool environment', () => {
  const layout = resolveOpenCodeNativeStateLayout({
    namespaceKey: 'a'.repeat(64),
    agorSessionId: '01a08d5f-775f-73f6-86a1-624b43050180',
    taskId: '01a08d5f-7773-77fa-a7dc-2575cfe67270',
    storeId: '01a08d5f-7773-77fa-a7dc-2575cfe67260',
    homeDir: '/owner',
    scratchRoot: '/scratch',
  });
  const env = hostedOpenCodeEnvironment(layout, {
    HOME: '/owner',
    PATH: '/tools',
    OPENCODE_CONFIG: '/untrusted.json',
    OPENCODE_CONFIG_DIR: '/untrusted',
    OPENCODE_CONFIG_CONTENT: '{}',
    OPENCODE_MODELS_PATH: '/untrusted-models.json',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'false',
    OPENCODE_PURE: 'false',
    OPENCODE_TEST_HOME: '/untrusted',
    OPENCODE_AUTH_CONTENT: 'untrusted',
  });
  expect(env).toMatchObject({
    HOME: '/owner',
    PATH: '/tools',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_PURE: 'true',
    OPENCODE_TEST_HOME: layout.scratchRoot,
  });
  for (const key of [
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_MODELS_PATH',
    'OPENCODE_AUTH_CONTENT',
  ])
    expect(env[key]).toBeUndefined();
});

// Explicit opt-in keeps ordinary unit tests independent of binary installation.
// Run with AGOR_OPENCODE_TEST_BINARY pointing at the exact pinned executable.
describe.skipIf(!process.env.AGOR_OPENCODE_TEST_BINARY)(
  'pinned hosted configuration boundary',
  () => {
    it('excludes project, ancestor, home and environment config before plugins or MCP can execute', async () => {
      const binary = process.env.AGOR_OPENCODE_TEST_BINARY!;
      await assertOpenCodeBinaryCompatibility(binary);
      const root = await realpath(await mkdtemp(join(tmpdir(), 'agor-hosted-config-')));
      roots.push(root);
      const work = join(root, 'repo', 'nested');
      const home = join(root, 'home');
      const marker = join(root, 'plugin-ran');
      const mcpMarker = join(root, 'mcp-ran');
      const plugin = join(root, 'probe.mjs');
      await mkdir(work, { recursive: true });
      await writeFile(
        plugin,
        `import {writeFileSync} from 'node:fs'; export const Probe=async()=>{writeFileSync(${JSON.stringify(marker)}, 'ran');return {}};`
      );
      const excluded = JSON.stringify({
        plugin: [`file://${plugin}`],
        provider: { openai: { options: { baseURL: 'http://127.0.0.1:9/synthetic-provider' } } },
        mcp: {
          unexpected: {
            type: 'local',
            command: [
              process.execPath,
              '-e',
              `require('fs').writeFileSync(${JSON.stringify(mcpMarker)}, 'ran')`,
            ],
            enabled: true,
          },
        },
      });
      for (const directory of [
        work,
        join(root, 'repo'),
        join(work, '.opencode'),
        join(home, '.opencode'),
        join(root, 'env-config'),
      ]) {
        await mkdir(join(directory, 'plugins'), { recursive: true });
        await writeFile(join(directory, 'opencode.json'), excluded);
        await writeFile(join(directory, 'plugins', 'probe.mjs'), await readFile(plugin));
      }
      vi.stubEnv('HOME', home);
      vi.stubEnv('OPENCODE_CONFIG', join(work, 'opencode.json'));
      vi.stubEnv('OPENCODE_CONFIG_DIR', join(root, 'env-config'));
      vi.stubEnv('OPENCODE_TEST_HOME', home);
      vi.stubEnv('OPENCODE_TEST_MANAGED_CONFIG_DIR', join(root, 'env-config'));
      vi.stubEnv('OPENCODE_DISABLE_PROJECT_CONFIG', 'false');
      vi.stubEnv('OPENCODE_PURE', 'false');
      const layout = resolveOpenCodeNativeStateLayout({
        namespaceKey: 'a'.repeat(64),
        agorSessionId: '01a08d5f-775f-73f6-86a1-624b43050180',
        taskId: '01a08d5f-7773-77fa-a7dc-2575cfe67270',
        storeId: '01a08d5f-7773-77fa-a7dc-2575cfe67260',
        homeDir: home,
        scratchRoot: join(root, 'scratch'),
      });
      await prepareOpenCodeScratch(layout);
      const server = await startManagedOpenCodeServer(
        {
          directory: work,
          hostedLayout: layout,
          environment: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: {}, permission: { '*': 'ask' } }),
            OPENCODE_AUTH_CONTENT: JSON.stringify({
              openai: { type: 'api', key: 'synthetic-test-key' },
            }),
          },
          secrets: ['synthetic-test-key'],
        },
        { resolveBinary: async () => binary, readinessTimeoutMs: 20000 }
      );
      try {
        const response = await fetch(
          `${server.baseUrl}/config?directory=${encodeURIComponent(work)}`,
          {
            headers: { Authorization: server.authorization },
            signal: AbortSignal.timeout(10000),
          }
        );
        expect(response.status).toBe(200);
        const config = await response.json();
        expect(config.plugin ?? []).toEqual([]);
        expect(config.provider?.openai?.options?.baseURL).toBeUndefined();
        expect(config.mcp?.unexpected).toBeUndefined();
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(mcpMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await server.close();
      }
    }, 30000);
  }
);
