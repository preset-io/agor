import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfigFromFile } from './config-manager';
import { resolveDeploymentConfig, resolveMcpOAuthCallbackOrigin } from './deployment';
import type { AgorConfig } from './types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('startup MCP OAuth callback origin', () => {
  it('preserves AGOR_BASE_URL > daemon.base_url > legacy ui.base_url precedence', () => {
    const config: AgorConfig = {
      daemon: { base_url: 'https://daemon.example.test' },
      ui: { base_url: 'https://legacy-ui.example.test' },
    };
    expect(
      resolveMcpOAuthCallbackOrigin(config, { AGOR_BASE_URL: 'https://env.example.test' })
    ).toMatchObject({
      haCallbackUrl: 'https://env.example.test/mcp-servers/oauth-callback',
    });
    expect(resolveMcpOAuthCallbackOrigin(config, {})).toMatchObject({
      haCallbackUrl: 'https://daemon.example.test/mcp-servers/oauth-callback',
    });
    expect(resolveMcpOAuthCallbackOrigin({ ui: config.ui }, {})).toMatchObject({
      haCallbackUrl: 'https://legacy-ui.example.test/mcp-servers/oauth-callback',
    });
  });

  it('uses a custom-path snapshot even when the default-path source disagrees', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agor-oauth-origin-'));
    temporaryDirectories.push(directory);
    const customPath = join(directory, 'custom.yaml');
    const defaultPath = join(directory, 'default.yaml');
    await writeFile(customPath, 'daemon:\n  base_url: https://custom.example.test\n');
    await writeFile(defaultPath, 'daemon:\n  base_url: https://wrong-default.example.test\n');

    const defaultConfig = await loadConfigFromFile(defaultPath);
    expect(defaultConfig.daemon?.base_url).toBe('https://wrong-default.example.test');
    const custom = await loadConfigFromFile(customPath);
    const resolved = resolveMcpOAuthCallbackOrigin(custom, {});
    expect(resolved).toEqual({
      standaloneCallbackUrl: 'https://custom.example.test/mcp-servers/oauth-callback',
      haCallbackUrl: 'https://custom.example.test/mcp-servers/oauth-callback',
    });
  });

  it('resolves directly injected config without consulting a config file', () => {
    expect(
      resolveMcpOAuthCallbackOrigin({ daemon: { base_url: 'https://injected.example.test' } }, {})
    ).toEqual({
      standaloneCallbackUrl: 'https://injected.example.test/mcp-servers/oauth-callback',
      haCallbackUrl: 'https://injected.example.test/mcp-servers/oauth-callback',
    });
  });

  it('fails closed for missing or unsafe origins while retaining standalone loopback', () => {
    expect(resolveMcpOAuthCallbackOrigin({}, {})).toEqual({
      standaloneCallbackUrl: null,
      haCallbackUrl: null,
    });
    expect(
      resolveMcpOAuthCallbackOrigin(
        { daemon: { public_url: 'https://runtime-only.example.test' } },
        {}
      )
    ).toEqual({ standaloneCallbackUrl: null, haCallbackUrl: null });
    for (const base_url of [
      'http://agor.example.test',
      'https://localhost:3030',
      'https://10.0.0.1',
      'file:///tmp/callback',
      'not a URL',
    ]) {
      expect(resolveMcpOAuthCallbackOrigin({ daemon: { base_url } }, {}).haCallbackUrl).toBeNull();
    }
    expect(
      resolveMcpOAuthCallbackOrigin({ daemon: { base_url: 'http://127.0.0.1:3030' } }, {})
    ).toEqual({
      standaloneCallbackUrl: 'http://127.0.0.1:3030/mcp-servers/oauth-callback',
      haCallbackUrl: null,
    });
  });

  it('advertises exactly the callback URL supplied to HA runtime', () => {
    const origin = resolveMcpOAuthCallbackOrigin(
      { daemon: { base_url: 'https://frozen.example.test' } },
      {}
    );
    const deployment = resolveDeploymentConfig(
      {
        deployment: {
          mode: 'ha',
          redis: { url: 'rediss://redis.internal:6380/2', key_prefix: 'test' },
          ha: {
            support_profile: 'constrained-active-active',
            execution_topology: 'shared-local',
            shared_filesystem: true,
            ingress_affinity: true,
          },
        },
        database: { dialect: 'postgresql' },
        execution: {
          allow_web_terminal: false,
          managed_envs_execution_mode: 'webhook-only',
          executor_storage: {
            user_home: 'shared',
            user_home_locking: 'cross-replica-flock',
            branch_workspace: 'shared',
            base_repository: 'shared',
          },
        },
      },
      {
        AGOR_JWT_SECRET: 'j'.repeat(32),
        AGOR_MASTER_SECRET: 'm'.repeat(32),
        AGOR_ADMIN_PASSWORD: 'admin-password',
      },
      undefined,
      origin
    );
    expect(deployment.mode).toBe('ha');
    if (deployment.mode !== 'ha') throw new Error('expected HA');
    expect(deployment.capabilities.mcpOAuth).toBe(true);
    expect(deployment.mcpOAuthCallbackUrl).toBe(origin.haCallbackUrl);
  });
});
