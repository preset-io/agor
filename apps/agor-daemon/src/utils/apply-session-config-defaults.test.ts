/**
 * Tests for `applySessionConfigDefaults` — the before-create hook that
 * auto-fills `permission_config` and `model_config` from the creator's
 * default_agentic_config[tool] when the caller omits them.
 *
 * Regression target: preset-io/agor#1064 — UI drag-into-zone created
 * sessions with `permission_config: null`, which Claude Code interprets as
 * the most restrictive mode and which made every dragged session hang.
 */

import type { HookContext } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applySessionConfigDefaults } from './apply-session-config-defaults';

const ALICE = 'user-alice';

interface FakeUser {
  user_id: string;
  default_agentic_config?: Record<string, unknown>;
}

function makeContext(opts: {
  provider?: string;
  data?: Record<string, unknown>;
  users?: Record<string, FakeUser | null>;
  user?: { user_id: string };
}): HookContext {
  const usersService = {
    get: vi.fn(async (id: string) => {
      const u = opts.users?.[id];
      if (u === undefined) throw new Error(`user ${id} not found`);
      return u;
    }),
  };
  return {
    params: { provider: opts.provider, user: opts.user },
    data: opts.data,
    app: { service: vi.fn(() => usersService) },
  } as unknown as HookContext;
}

describe('applySessionConfigDefaults', () => {
  beforeEach(() => {
    // Restore any prior spies first so per-test `vi.spyOn(console, 'warn')`
    // calls get a fresh spy rather than appending to a shared call history.
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it("fills missing permission_config from the user's default for the tool", async () => {
    const hook = applySessionConfigDefaults({ warnOnExternalDefaultFill: false });
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: ALICE },
      data: { agentic_tool: 'claude-code', created_by: ALICE },
      users: {
        [ALICE]: {
          user_id: ALICE,
          default_agentic_config: { 'claude-code': { permissionMode: 'bypassPermissions' } },
        },
      },
    });
    await hook(ctx);
    expect((ctx.data as { permission_config: { mode: string } }).permission_config.mode).toBe(
      'bypassPermissions'
    );
  });

  it('does not overwrite an explicit permission_config supplied by the caller', async () => {
    const hook = applySessionConfigDefaults({ warnOnExternalDefaultFill: false });
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: ALICE },
      data: {
        agentic_tool: 'claude-code',
        created_by: ALICE,
        permission_config: { mode: 'plan' },
      },
      users: {
        [ALICE]: {
          user_id: ALICE,
          default_agentic_config: { 'claude-code': { permissionMode: 'bypassPermissions' } },
        },
      },
    });
    await hook(ctx);
    expect((ctx.data as { permission_config: { mode: string } }).permission_config.mode).toBe(
      'plan'
    );
  });

  it("fills missing model_config from the user's default", async () => {
    const hook = applySessionConfigDefaults({ warnOnExternalDefaultFill: false });
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: ALICE },
      data: { agentic_tool: 'claude-code', created_by: ALICE },
      users: {
        [ALICE]: {
          user_id: ALICE,
          default_agentic_config: {
            'claude-code': { modelConfig: { model: 'claude-opus-4-6' } },
          },
        },
      },
    });
    await hook(ctx);
    expect((ctx.data as { model_config: { model: string } }).model_config.model).toBe(
      'claude-opus-4-6'
    );
  });

  it('falls back to system default permission mode when user has no defaults', async () => {
    const hook = applySessionConfigDefaults({ warnOnExternalDefaultFill: false });
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: ALICE },
      data: { agentic_tool: 'claude-code', created_by: ALICE },
      users: { [ALICE]: { user_id: ALICE } },
    });
    await hook(ctx);
    // System default for claude-code is 'bypassPermissions'
    expect((ctx.data as { permission_config: { mode: string } }).permission_config.mode).toBe(
      'bypassPermissions'
    );
  });

  it('does nothing when both fields are already set', async () => {
    const usersGet = vi.fn();
    const ctx = {
      params: { provider: 'rest', user: { user_id: ALICE } },
      data: {
        agentic_tool: 'claude-code',
        created_by: ALICE,
        permission_config: { mode: 'plan' },
        model_config: { mode: 'alias', model: 'x', updated_at: 'now' },
      },
      app: { service: vi.fn(() => ({ get: usersGet })) },
    } as unknown as HookContext;
    await applySessionConfigDefaults({ warnOnExternalDefaultFill: false })(ctx);
    expect(usersGet).not.toHaveBeenCalled();
  });

  it('is a no-op when agentic_tool is missing (cannot resolve defaults)', async () => {
    const hook = applySessionConfigDefaults({ warnOnExternalDefaultFill: false });
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: ALICE },
      data: { created_by: ALICE },
      users: { [ALICE]: { user_id: ALICE } },
    });
    await hook(ctx);
    expect((ctx.data as { permission_config?: unknown }).permission_config).toBeUndefined();
  });

  it('is a no-op when created_by is missing', async () => {
    const hook = applySessionConfigDefaults({ warnOnExternalDefaultFill: false });
    const ctx = makeContext({
      data: { agentic_tool: 'claude-code' },
      users: {},
    });
    await hook(ctx);
    expect((ctx.data as { permission_config?: unknown }).permission_config).toBeUndefined();
  });

  it('still fills defaults if the user lookup fails (degrades to system fallback)', async () => {
    const hook = applySessionConfigDefaults({ warnOnExternalDefaultFill: false });
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: ALICE },
      data: { agentic_tool: 'claude-code', created_by: ALICE },
      users: { [ALICE]: undefined as unknown as null }, // triggers throw in fake
    });
    await hook(ctx);
    // System default for claude-code
    expect((ctx.data as { permission_config: { mode: string } }).permission_config.mode).toBe(
      'bypassPermissions'
    );
  });

  it('warns when filling defaults on an external call (when warnOnExternalDefaultFill: true)', async () => {
    const hook = applySessionConfigDefaults({ warnOnExternalDefaultFill: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: ALICE },
      data: { agentic_tool: 'claude-code', created_by: ALICE },
      users: { [ALICE]: { user_id: ALICE } },
    });
    await hook(ctx);
    const matched = warnSpy.mock.calls.some(
      ([msg]) => typeof msg === 'string' && msg.includes('Filled missing permission_config')
    );
    expect(matched).toBe(true);
  });

  it('does not warn for internal calls (no provider)', async () => {
    const hook = applySessionConfigDefaults({ warnOnExternalDefaultFill: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = makeContext({
      // no provider
      data: { agentic_tool: 'claude-code', created_by: ALICE },
      users: { [ALICE]: { user_id: ALICE } },
    });
    await hook(ctx);
    const matched = warnSpy.mock.calls.some(
      ([msg]) => typeof msg === 'string' && msg.includes('Filled missing permission_config')
    );
    expect(matched).toBe(false);
  });

  describe('regression: issue #1064', () => {
    it('UI-shaped payload (no permission_config) gets bypassPermissions when user default is bypassPermissions', async () => {
      // Mirrors the exact UI drag-into-zone payload from
      // SessionCanvas.tsx: just {worktree_id, description, status, agentic_tool}.
      const hook = applySessionConfigDefaults({ warnOnExternalDefaultFill: false });
      const ctx = makeContext({
        provider: 'rest',
        user: { user_id: ALICE },
        data: {
          worktree_id: 'wt-1',
          description: 'Session from zone "Yolo refactor"',
          status: 'idle',
          agentic_tool: 'claude-code',
          created_by: ALICE,
        },
        users: {
          [ALICE]: {
            user_id: ALICE,
            default_agentic_config: { 'claude-code': { permissionMode: 'bypassPermissions' } },
          },
        },
      });
      await hook(ctx);
      const data = ctx.data as { permission_config: { mode: string } };
      expect(data.permission_config).not.toBeNull();
      expect(data.permission_config.mode).toBe('bypassPermissions');
    });
  });
});
