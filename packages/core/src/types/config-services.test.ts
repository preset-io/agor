/**
 * Service Tier Configuration Tests
 *
 * Tests for DaemonServicesConfig resolution, dependency validation,
 * auto-promotion, and tier utility functions.
 */

import { describe, expect, it } from 'vitest';
import type { DaemonServicesConfig } from './config-services';
import {
  ALLOWED_SERVICE_TIERS,
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
  SERVICE_TIERS,
  validateAllowedTiers,
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

describe('SERVICE_TIERS', () => {
  it('contains all four tiers in order', () => {
    expect(SERVICE_TIERS).toEqual(['off', 'internal', 'readonly', 'on']);
  });

  it('matches SERVICE_TIER_RANK keys', () => {
    expect(new Set(SERVICE_TIERS)).toEqual(new Set(Object.keys(SERVICE_TIER_RANK)));
  });
});

describe('SERVICE_TIER_RANK', () => {
  it('orders tiers as off < internal < readonly < on', () => {
    expect(SERVICE_TIER_RANK.off).toBeLessThan(SERVICE_TIER_RANK.internal);
    expect(SERVICE_TIER_RANK.internal).toBeLessThan(SERVICE_TIER_RANK.readonly);
    expect(SERVICE_TIER_RANK.readonly).toBeLessThan(SERVICE_TIER_RANK.on);
  });
});

// ============================================================================
// ALLOWED_SERVICE_TIERS
// ============================================================================

describe('ALLOWED_SERVICE_TIERS', () => {
  it('has entries for all service groups', () => {
    for (const group of SERVICE_GROUP_NAMES) {
      expect(ALLOWED_SERVICE_TIERS[group]).toBeDefined();
    }
  });

  it('core infrastructure services cannot be off', () => {
    for (const group of ['core', 'branches', 'repos', 'users'] as const) {
      expect(ALLOWED_SERVICE_TIERS[group]).not.toContain('off');
      expect(ALLOWED_SERVICE_TIERS[group]).toContain('on');
      expect(ALLOWED_SERVICE_TIERS[group]).toContain('internal');
    }
  });

  it('optional services can be off', () => {
    for (const group of [
      'boards',
      'cards',
      'artifacts',
      'gateway',
      'scheduler',
      'knowledge',
    ] as const) {
      expect(ALLOWED_SERVICE_TIERS[group]).toContain('off');
    }
  });
});

// ============================================================================
// validateAllowedTiers
// ============================================================================

describe('validateAllowedTiers', () => {
  it('returns no violations for undefined config', () => {
    expect(validateAllowedTiers(undefined)).toEqual([]);
  });

  it('returns no violations for empty config', () => {
    expect(validateAllowedTiers({})).toEqual([]);
  });

  it('returns no violations for valid config', () => {
    const config: DaemonServicesConfig = {
      core: 'on',
      users: 'internal',
      boards: 'off',
      repos: 'readonly',
    };
    expect(validateAllowedTiers(config)).toEqual([]);
  });

  it('returns violation when core is set to off', () => {
    const config: DaemonServicesConfig = { core: 'off' };
    const violations = validateAllowedTiers(config);
    expect(violations).toHaveLength(1);
    expect(violations[0].group).toBe('core');
    expect(violations[0].tier).toBe('off');
    expect(violations[0].allowed).not.toContain('off');
  });

  it('returns violations for multiple infra services set to off', () => {
    const config: DaemonServicesConfig = { core: 'off', users: 'off', repos: 'off' };
    const violations = validateAllowedTiers(config);
    expect(violations).toHaveLength(3);
    expect(violations.map((v) => v.group).sort()).toEqual(['core', 'repos', 'users']);
  });

  it('allows optional services to be off', () => {
    const config: DaemonServicesConfig = {
      boards: 'off',
      cards: 'off',
      gateway: 'off',
      scheduler: 'off',
      knowledge: 'off',
    };
    expect(validateAllowedTiers(config)).toEqual([]);
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

  it('returns no violations when all dependencies are at least internal', () => {
    const config: DaemonServicesConfig = { core: 'on', users: 'internal', branches: 'readonly' };
    expect(validateServiceDependencies(config)).toEqual([]);
  });

  it('skips dependency check when the dependent service itself is off', () => {
    // gateway and scheduler are off, so their deps are irrelevant
    const config: DaemonServicesConfig = {
      gateway: 'off',
      scheduler: 'off',
      knowledge: 'off',
    };
    expect(validateServiceDependencies(config)).toEqual([]);
  });

  it('validates scheduler depends on core and branches (pure function, ignoring allowed tiers)', () => {
    // Note: core/branches: 'off' would be rejected by validateAllowedTiers first,
    // but this tests the pure dependency validation logic in isolation.
    const config: DaemonServicesConfig = {
      scheduler: 'on',
      core: 'off' as any,
      branches: 'off' as any,
    };
    const violations = validateServiceDependencies(config);
    expect(
      violations.find((v) => v.service === 'scheduler' && v.dependency === 'core')
    ).toBeDefined();
    expect(
      violations.find((v) => v.service === 'scheduler' && v.dependency === 'branches')
    ).toBeDefined();
  });
});

// ============================================================================
// autoPromoteDependencies
// ============================================================================

describe('autoPromoteDependencies', () => {
  it('does not demote existing higher tiers', () => {
    const config: DaemonServicesConfig = { core: 'on', users: 'on', branches: 'readonly' };
    const { config: result, promotions } = autoPromoteDependencies(config);
    expect(result.users).toBe('on');
    expect(result.branches).toBe('readonly');
    expect(promotions).toHaveLength(0);
  });

  it('does not promote when the dependent service is off', () => {
    const config: DaemonServicesConfig = {
      gateway: 'off',
      scheduler: 'off',
      knowledge: 'off',
    };
    const { promotions } = autoPromoteDependencies(config);
    expect(promotions).toHaveLength(0);
  });

  it('returns no promotions when all deps are already satisfied', () => {
    const config: DaemonServicesConfig = {
      core: 'on',
      users: 'internal',
      branches: 'internal',
      scheduler: 'on',
      gateway: 'on',
    };
    const { promotions } = autoPromoteDependencies(config);
    expect(promotions).toHaveLength(0);
  });

  it('promotes off deps to internal (pure function, bypassing allowed-tiers check)', () => {
    // In practice, core/branches can't be 'off' (blocked by validateAllowedTiers),
    // but autoPromoteDependencies is a pure function that handles it correctly.
    const config = {
      scheduler: 'on',
      core: 'off',
      branches: 'off',
    } as DaemonServicesConfig;
    const { config: result, promotions } = autoPromoteDependencies(config);
    expect(result.core).toBe('internal');
    expect(result.branches).toBe('internal');
    expect(promotions.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// SERVICE_GROUP_NAMES and SERVICE_GROUP_TO_MCP_DOMAINS consistency
// ============================================================================

describe('SERVICE_GROUP_NAMES', () => {
  it('contains all 14 service groups', () => {
    expect(SERVICE_GROUP_NAMES).toHaveLength(14);
  });

  it('includes the expected groups', () => {
    const expected = [
      'core',
      'branches',
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
      'knowledge',
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

  it('maps branches to both branches and environment domains', () => {
    expect(SERVICE_GROUP_TO_MCP_DOMAINS.branches).toContain('branches');
    expect(SERVICE_GROUP_TO_MCP_DOMAINS.branches).toContain('environment');
  });

  it('maps knowledge to knowledge domain', () => {
    expect(SERVICE_GROUP_TO_MCP_DOMAINS.knowledge).toContain('knowledge');
  });
});

// ============================================================================
// Executor pod scenario (integration-style)
// ============================================================================

describe('executor pod config scenario', () => {
  const executorConfig: DaemonServicesConfig = {
    core: 'on',
    branches: 'on',
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
    knowledge: 'off',
  };

  it('passes allowed-tiers validation', () => {
    expect(validateAllowedTiers(executorConfig)).toEqual([]);
  });

  it('has no dependency violations', () => {
    expect(validateServiceDependencies(executorConfig)).toEqual([]);
  });

  it('core services are fully accessible', () => {
    expect(isServiceFullAccess(executorConfig, 'core')).toBe(true);
    expect(isServiceFullAccess(executorConfig, 'branches')).toBe(true);
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
    expect(isServiceEnabled(executorConfig, 'knowledge')).toBe(false);
  });
});
