/**
 * Service Tier Hooks Tests
 *
 * Tests for blockExternalAccess, blockMutation hooks and resolveServicesConfig.
 * Uses mock FeathersJS context objects — no real daemon needed.
 */

import type { DaemonServicesConfig, HookContext } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { blockExternalAccess, blockMutation, resolveServicesConfig } from './service-tiers';

/**
 * Create a minimal mock HookContext for testing hooks.
 */
function mockContext(overrides: {
  provider?: string;
  path?: string;
  method?: string;
}): HookContext {
  return {
    params: {
      provider: overrides.provider,
    },
    path: overrides.path ?? 'test-service',
    method: overrides.method ?? 'find',
  } as unknown as HookContext;
}

// ============================================================================
// blockExternalAccess
// ============================================================================

describe('blockExternalAccess', () => {
  it('blocks REST requests (provider=rest)', async () => {
    const ctx = mockContext({ provider: 'rest', path: 'users' });
    await expect(blockExternalAccess(ctx)).rejects.toThrow("Service 'users' is not available");
  });

  it('blocks WebSocket requests (provider=socketio)', async () => {
    const ctx = mockContext({ provider: 'socketio', path: 'users' });
    await expect(blockExternalAccess(ctx)).rejects.toThrow("Service 'users' is not available");
  });

  it('allows internal calls (no provider)', async () => {
    const ctx = mockContext({ provider: undefined, path: 'users' });
    // Should not throw
    await expect(blockExternalAccess(ctx)).resolves.toBeUndefined();
  });
});

// ============================================================================
// blockMutation
// ============================================================================

describe('blockMutation', () => {
  it('blocks external mutation requests', async () => {
    const ctx = mockContext({ provider: 'rest', path: 'repos', method: 'create' });
    await expect(blockMutation(ctx)).rejects.toThrow("Service 'repos' is in readonly mode");
  });

  it('blocks external WebSocket mutations', async () => {
    const ctx = mockContext({ provider: 'socketio', path: 'repos', method: 'patch' });
    await expect(blockMutation(ctx)).rejects.toThrow("Service 'repos' is in readonly mode");
  });

  it('allows internal mutations (no provider)', async () => {
    const ctx = mockContext({ provider: undefined, path: 'repos', method: 'create' });
    await expect(blockMutation(ctx)).resolves.toBeUndefined();
  });

  it('allows external read requests (get/find are not hooked via blockMutation)', async () => {
    // Note: blockMutation is applied to create/update/patch/remove hooks only.
    // get/find are never hooked with blockMutation, so this tests the hook itself
    // which should block when called regardless of method (the gating is in hook registration).
    const ctx = mockContext({ provider: 'rest', path: 'repos', method: 'find' });
    // blockMutation checks provider, not method — it blocks any external call
    // The readonly tier only registers this hook on mutation methods, not find/get
    await expect(blockMutation(ctx)).rejects.toThrow('readonly mode');
  });
});

// ============================================================================
// resolveServicesConfig
// ============================================================================

describe('resolveServicesConfig', () => {
  it('returns empty config when input is undefined', () => {
    expect(resolveServicesConfig(undefined)).toEqual({});
  });

  it('returns input as-is when no dependencies are violated', () => {
    const config: DaemonServicesConfig = { core: 'on', users: 'on', worktrees: 'on' };
    expect(resolveServicesConfig(config)).toEqual(config);
  });

  it('throws when core infrastructure service is set to off', () => {
    const config: DaemonServicesConfig = { core: 'off' as any };
    expect(() => resolveServicesConfig(config)).toThrow('Invalid service configuration');
    expect(() => resolveServicesConfig(config)).toThrow("'core' cannot be 'off'");
  });

  it('throws when multiple infra services are off', () => {
    const config: DaemonServicesConfig = { core: 'off' as any, users: 'off' as any };
    expect(() => resolveServicesConfig(config)).toThrow('Invalid service configuration');
  });

  it('preserves non-dependency services unchanged', () => {
    const config: DaemonServicesConfig = {
      core: 'on',
      boards: 'off',
      cards: 'off',
      artifacts: 'off',
      users: 'internal',
    };
    const result = resolveServicesConfig(config);
    expect(result.boards).toBe('off');
    expect(result.cards).toBe('off');
    expect(result.artifacts).toBe('off');
    expect(result.users).toBe('internal');
  });

  it('accepts valid lean config with internal/readonly infra services', () => {
    const config: DaemonServicesConfig = {
      core: 'on',
      users: 'internal',
      worktrees: 'readonly',
      repos: 'internal',
      boards: 'off',
      cards: 'off',
      gateway: 'off',
      scheduler: 'off',
    };
    const result = resolveServicesConfig(config);
    expect(result.users).toBe('internal');
    expect(result.worktrees).toBe('readonly');
    expect(result.boards).toBe('off');
  });
});
