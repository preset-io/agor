import { describe, expect, it } from 'vitest';
import {
  assertHostedOpenCodeInvocationConfig,
  hostedOpenCodeEnvironment,
  hostedOpenCodeInvocationConfig,
} from './hosted-config.js';
import { resolveOpenCodeNativeStateLayout } from './native-state.js';

describe('hosted OpenCode configuration', () => {
  const layout = resolveOpenCodeNativeStateLayout({
    sessionId: '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a50',
    taskId: '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51',
    sdkHomeScope: 'execution_home',
    env: { AGOR_OPENCODE_SCRATCH_ROOT: '/scratch' },
    homeDir: '/home/owner',
  });

  it('pins every native root to scratch and drops inherited OpenCode selectors', () => {
    const env = hostedOpenCodeEnvironment(layout, {
      HOME: '/home/owner',
      PATH: '/usr/bin',
      OPENCODE_CONFIG: '/home/owner/evil.json',
      OPENCODE_AUTH_CONTENT: '{"x":1}',
    });
    expect(env).toMatchObject({
      HOME: '/home/owner',
      PATH: '/usr/bin',
      XDG_DATA_HOME: layout.xdg.data,
      OPENCODE_DB: layout.liveDbPath,
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      OPENCODE_TEST_HOME: layout.scratchRoot,
      TMPDIR: layout.scratchRoot,
    });
    expect(env.OPENCODE_CONFIG).toBeUndefined();
    expect(env.OPENCODE_AUTH_CONTENT).toBeUndefined();
  });

  it('refuses plugins, provider overrides, and local MCP commands', () => {
    expect(() => assertHostedOpenCodeInvocationConfig({ mcp: {}, plugin: ['x'] })).toThrow();
    expect(() => assertHostedOpenCodeInvocationConfig({ mcp: {}, provider: {} })).toThrow();
    expect(() =>
      assertHostedOpenCodeInvocationConfig({ mcp: { local: { type: 'local', command: ['sh'] } } })
    ).toThrow(/remote MCP/);
    expect(() =>
      assertHostedOpenCodeInvocationConfig({ mcp: { agor: { type: 'remote', url: 'https://x' } } })
    ).not.toThrow();
  });

  it('disables native sharing in the serialised config, whatever the resolved config asked for', () => {
    const config = hostedOpenCodeInvocationConfig({
      mcp: { agor: { type: 'remote', url: 'https://x' } },
      share: 'auto',
    });
    expect(JSON.parse(JSON.stringify(config))).toMatchObject({ share: 'disabled' });
    expect(() => hostedOpenCodeInvocationConfig({ mcp: {}, plugin: ['x'] })).toThrow();
  });
});
