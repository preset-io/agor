import { describe, expect, it } from 'vitest';
import { resolveChildSessionConfig } from './resolve-child-session-config';
import type { SessionRuntimeOverrides } from './resolve-permission-config';
import { resolvePermissionConfig } from './resolve-permission-config';

describe('Codex session plugin preference', () => {
  it.each(
    [undefined, false, true].flatMap((user) =>
      [undefined, false, true].flatMap((parent) =>
        [undefined, false, true].map((override) => ({ user, parent, override }))
      )
    )
  )(
    'resolves explicit $override > parent $parent > user $user > off',
    ({ user, parent, override }) => {
      const result = resolvePermissionConfig({
        effectiveTool: 'codex',
        overrides: { codexIncludePlugins: override },
        parentLayer: { codexIncludePlugins: parent },
        userToolDefaults: { codexIncludePlugins: user },
      });
      expect(result.codex?.includePlugins).toBe(override ?? parent ?? user ?? false);
    }
  );

  it('does not add Codex configuration to other tools', () => {
    expect(
      resolvePermissionConfig({
        effectiveTool: 'claude-code',
        overrides: { codexIncludePlugins: true },
      })
    ).not.toHaveProperty('codex');
  });

  it.each(['true', 'false', null, 1, {}, []])('rejects invalid plugin preference %j', (value) => {
    expect(() =>
      resolvePermissionConfig({
        effectiveTool: 'codex',
        overrides: { codexIncludePlugins: value } as SessionRuntimeOverrides,
      })
    ).toThrow('codexIncludePlugins must be a boolean');
  });
});

it('gates parent plugin inheritance on the child tool and preserves explicit opt-out', () => {
  const parent = {
    agentic_tool: 'codex' as const,
    permission_config: {
      codex: {
        sandboxMode: 'read-only' as const,
        approvalPolicy: 'never' as const,
        includePlugins: true,
      },
    },
  };
  expect(resolveChildSessionConfig({ parent }).permission_config.codex?.includePlugins).toBe(true);
  expect(
    resolveChildSessionConfig({ parent, overrides: { codexIncludePlugins: false } })
      .permission_config.codex?.includePlugins
  ).toBe(false);
  expect(
    resolveChildSessionConfig({ parent, effectiveTool: 'claude-code' }).permission_config.codex
  ).toBeUndefined();
  expect(
    resolveChildSessionConfig({
      parent: { ...parent, agentic_tool: 'claude-code' },
      effectiveTool: 'codex',
    }).permission_config.codex?.includePlugins
  ).toBe(false);
});
