/**
 * Service Tier Configuration Tests
 *
 * Tests for DaemonServicesConfig resolution, dependency validation,
 * auto-promotion, and tier utility functions.
 */

import { describe, expect, it } from 'vitest';
import type { DaemonServicesConfig } from './config-services';
import {
  autoPromoteDependencies,
  DEFAULT_SERVICE_TIER,
  getServiceTier,
  isServiceEnabled,
  isServiceExternallyAccessible,
  isServiceFullAccess,
  SERVICE_DEPENDENCIES,
  SERVICE_GROUP_NAMES,
  SERVICE_GROUP_TO_MCP_DOMAINS,
  SERVICE_TIER_RANK,
  validateServiceDependencies,
} from './config-services';

// ============================================================================
// getServiceTier
// ============================================================================

describe('getServiceTier', () => {
  it('returns configured tier when explicitly set', () => {
    const config: DaemonServicesConfig = { core: 'on', boards: 'off', users: 'internal' };
    expect(getServiceTier(config, 'core')).toBe('on');
    expect(getServiceTier(config, 'boards')).toBe('off');
    expect(getServiceTier(config, 'users')).toBe('internal');
  });

  it('returns default tier (on) for unconfigured groups', () => {
    const config: DaemonServicesConfig = { core: 'on' };
    expect(getServiceTier(config, 'boards')).toBe(DEFAULT_SERVICE_TIER);
    expect(getServiceTier(config, 'gateway')).toBe('on');
  });

  it('returns default tier when config is undefined', () => {
    expect(getServiceTier(undefined, 'core')).toBe('on');
    expect(getServiceTier(undefined, 'boards')).toBe('on');
  });
});

// ============================================================================
// isServiceEnabled
// ============================================================================

describe('isServiceEnabled', () => {
  it('returns true for on, internal, and readonly tiers', () => {
    const config: DaemonServicesConfig = {
      core: 'on',
      users: 'internal',
      repos: 'readonly',
    };
    expect(isServiceEnabled(config, 'core')).toBe(true);
    expect(isServiceEnabled(config, 'users')).toBe(true);
    expect(isServiceEnabled(config, 'repos')).toBe(true);
  });

  it('returns false only for off tier', () => {
    const config: DaemonServicesConfig = { boards: 'off' };
    expect(isServiceEnabled(config, 'boards')).toBe(false);
  });

  it('returns true for unconfigured groups (default is on)', () => {
    expect(isServiceEnabled({}, 'core')).toBe(true);
    expect(isServiceEnabled(undefined, 'boards')).toBe(true);
  });
});

// ============================================================================
// isServiceExternallyAccessible
// ============================================================================

describe('isServiceExternallyAccessible', () => {
  it('returns true for on and readonly', () => {
    const config: DaemonServicesConfig = { repos: 'readonly', core: 'on' };
    expect(isServiceExternallyAccessible(config, 'repos')).toBe(true);
    expect(isServiceExternallyAccessible(config, 'core')).toBe(true);
  });

  it('returns false for off and internal', () => {
    const config: DaemonServicesConfig = { boards: 'off', users: 'internal' };
    expect(isServiceExternallyAccessible(config, 'boards')).toBe(false);
    expect(isServiceExternallyAccessible(config, 'users')).toBe(false);
  });
});

// ============================================================================
// isServiceFullAccess
// ============================================================================

describe('isServiceFullAccess', () => {
  it('returns true only for on tier', () => {
    expect(isServiceFullAccess({ core: 'on' }, 'core')).toBe(true);
  });

  it('returns false for all other tiers', () => {
    expect(isServiceFullAccess({ repos: 'readonly' }, 'repos')).toBe(false);
    expect(isServiceFullAccess({ users: 'internal' }, 'users')).toBe(false);
    expect(isServiceFullAccess({ boards: 'off' }, 'boards')).toBe(false);
  });
});

// ============================================================================
// SERVICE_TIER_RANK ordering
// ============================================================================

describe('SERVICE_TIER_RANK', () => {
  it('orders tiers as off < internal < readonly < on', () => {
    expect(SERVICE_TIER_RANK.off).toBeLessThan(SERVICE_TIER_RANK.internal);
    expect(SERVICE_TIER_RANK.internal).toBeLessThan(SERVICE_TIER_RANK.readonly);
    expect(SERVICE_TIER_RANK.readonly).toBeLessThan(SERVICE_TIER_RANK.on);
  });
});

// ============================================================================
// validateServiceDependencies
// ============================================================================

describe('validateServiceDependencies', () => {
  it('returns no violations when all services are on (default)', () => {
    expect(validateServiceDependencies(undefined)).toEqual([]);
    expect(validateServiceDependencies({})).toEqual([]);
  });

  it('returns violation when core is on but users is off', () => {
    const config: DaemonServicesConfig = { core: 'on', users: 'off' };
    const violations = validateServiceDependencies(config);
    expect(violations.length).toBeGreaterThan(0);
    const userViolation = violations.find((v) => v.service === 'core' && v.dependency === 'users');
    expect(userViolation).toBeDefined();
    expect(userViolation!.currentTier).toBe('off');
    expect(userViolation!.requiredTier).toBe('internal');
  });

  it('returns violation when core is on but worktrees is off', () => {
    const config: DaemonServicesConfig = { core: 'on', worktrees: 'off' };
    const violations = validateServiceDependencies(config);
    const wtViolation = violations.find(
      (v) => v.service === 'core' && v.dependency === 'worktrees'
    );
    expect(wtViolation).toBeDefined();
  });

  it('returns no violations when dependency is internal or higher', () => {
    const config: DaemonServicesConfig = { core: 'on', users: 'internal', worktrees: 'readonly' };
    expect(validateServiceDependencies(config)).toEqual([]);
  });

  it('skips dependency check when the service itself is off', () => {
    // Must also disable gateway and scheduler (they default to 'on' and depend on core/worktrees)
    const config: DaemonServicesConfig = {
      core: 'off',
      users: 'off',
      gateway: 'off',
      scheduler: 'off',
    };
    // core is off, so its deps on users/worktrees are irrelevant
    expect(validateServiceDependencies(config)).toEqual([]);
  });

  it('validates scheduler depends on core and worktrees', () => {
    const config: DaemonServicesConfig = { scheduler: 'on', core: 'off', worktrees: 'off' };
    const violations = validateServiceDependencies(config);
    expect(
      violations.find((v) => v.service === 'scheduler' && v.dependency === 'core')
    ).toBeDefined();
    expect(
      violations.find((v) => v.service === 'scheduler' && v.dependency === 'worktrees')
    ).toBeDefined();
  });
});

// ============================================================================
// autoPromoteDependencies
// ============================================================================

describe('autoPromoteDependencies', () => {
  it('promotes users from off to internal when core is on', () => {
    const config: DaemonServicesConfig = { core: 'on', users: 'off' };
    const { config: result, promotions } = autoPromoteDependencies(config);
    expect(result.users).toBe('internal');
    expect(promotions).toContainEqual({ group: 'users', from: 'off', to: 'internal' });
  });

  it('promotes multiple dependencies at once', () => {
    const config: DaemonServicesConfig = { core: 'on', users: 'off', worktrees: 'off' };
    const { config: result, promotions } = autoPromoteDependencies(config);
    expect(result.users).toBe('internal');
    expect(result.worktrees).toBe('internal');
    expect(promotions).toHaveLength(2);
  });

  it('does not demote existing higher tiers', () => {
    const config: DaemonServicesConfig = { core: 'on', users: 'on', worktrees: 'readonly' };
    const { config: result, promotions } = autoPromoteDependencies(config);
    expect(result.users).toBe('on');
    expect(result.worktrees).toBe('readonly');
    expect(promotions).toHaveLength(0);
  });

  it('does not promote when the dependent service is off', () => {
    // Must also disable gateway and scheduler (they default to 'on' and depend on core/worktrees)
    const config: DaemonServicesConfig = {
      core: 'off',
      users: 'off',
      gateway: 'off',
      scheduler: 'off',
    };
    const { config: result, promotions } = autoPromoteDependencies(config);
    expect(result.users).toBe('off');
    expect(promotions).toHaveLength(0);
  });

  it('handles transitive dependencies via scheduler', () => {
    // scheduler depends on core and worktrees
    const config: DaemonServicesConfig = {
      scheduler: 'on',
      core: 'off',
      worktrees: 'off',
      users: 'off',
    };
    const { config: result, promotions } = autoPromoteDependencies(config);
    // scheduler→core and scheduler→worktrees should be promoted
    expect(result.core).toBe('internal');
    expect(result.worktrees).toBe('internal');
    // Note: core→users is not promoted because autoPromoteDependencies
    // does a single pass. Users stays off unless we do recursive promotion.
    expect(promotions.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// SERVICE_GROUP_NAMES and SERVICE_GROUP_TO_MCP_DOMAINS consistency
// ============================================================================

describe('SERVICE_GROUP_NAMES', () => {
  it('contains all 13 service groups', () => {
    expect(SERVICE_GROUP_NAMES).toHaveLength(13);
  });

  it('includes the expected groups', () => {
    const expected = [
      'core',
      'worktrees',
      'repos',
      'users',
      'boards',
      'cards',
      'artifacts',
      'gateway',
      'scheduler',
      'terminals',
      'file_browser',
      'mcp_servers',
      'leaderboard',
    ];
    for (const group of expected) {
      expect(SERVICE_GROUP_NAMES).toContain(group);
    }
  });
});

describe('SERVICE_DEPENDENCIES', () => {
  it('all dependency values reference valid service groups', () => {
    for (const [, deps] of Object.entries(SERVICE_DEPENDENCIES)) {
      for (const dep of deps!) {
        expect(SERVICE_GROUP_NAMES).toContain(dep);
      }
    }
  });

  it('all dependency keys are valid service groups', () => {
    for (const key of Object.keys(SERVICE_DEPENDENCIES)) {
      expect(SERVICE_GROUP_NAMES).toContain(key);
    }
  });
});

describe('SERVICE_GROUP_TO_MCP_DOMAINS', () => {
  it('all keys are valid service groups', () => {
    for (const key of Object.keys(SERVICE_GROUP_TO_MCP_DOMAINS)) {
      expect(SERVICE_GROUP_NAMES).toContain(key);
    }
  });

  it('maps core to sessions domain', () => {
    expect(SERVICE_GROUP_TO_MCP_DOMAINS.core).toContain('sessions');
  });

  it('maps worktrees to both worktrees and environment domains', () => {
    expect(SERVICE_GROUP_TO_MCP_DOMAINS.worktrees).toContain('worktrees');
    expect(SERVICE_GROUP_TO_MCP_DOMAINS.worktrees).toContain('environment');
  });
});

// ============================================================================
// Executor pod scenario (integration-style)
// ============================================================================

describe('executor pod config scenario', () => {
  const executorConfig: DaemonServicesConfig = {
    core: 'on',
    worktrees: 'on',
    repos: 'readonly',
    mcp_servers: 'readonly',
    users: 'internal',
    boards: 'off',
    cards: 'off',
    artifacts: 'off',
    gateway: 'off',
    scheduler: 'off',
    terminals: 'off',
    file_browser: 'on',
    leaderboard: 'off',
  };

  it('has no dependency violations', () => {
    expect(validateServiceDependencies(executorConfig)).toEqual([]);
  });

  it('core services are fully accessible', () => {
    expect(isServiceFullAccess(executorConfig, 'core')).toBe(true);
    expect(isServiceFullAccess(executorConfig, 'worktrees')).toBe(true);
  });

  it('readonly services allow external reads but not writes', () => {
    expect(isServiceExternallyAccessible(executorConfig, 'repos')).toBe(true);
    expect(isServiceFullAccess(executorConfig, 'repos')).toBe(false);
  });

  it('internal services are enabled but not externally accessible', () => {
    expect(isServiceEnabled(executorConfig, 'users')).toBe(true);
    expect(isServiceExternallyAccessible(executorConfig, 'users')).toBe(false);
  });

  it('off services are completely disabled', () => {
    expect(isServiceEnabled(executorConfig, 'boards')).toBe(false);
    expect(isServiceEnabled(executorConfig, 'gateway')).toBe(false);
    expect(isServiceEnabled(executorConfig, 'scheduler')).toBe(false);
  });
});
