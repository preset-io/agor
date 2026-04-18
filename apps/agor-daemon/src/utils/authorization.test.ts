/**
 * Authorization Utilities Tests
 *
 * Tests for role hierarchy, minimum role enforcement, and superadmin/owner backwards compat.
 * Also verifies that `provider` presence controls whether auth hooks run.
 */

import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { ensureCanTriggerManagedEnv, ensureMinimumRole, requireMinimumRole } from './authorization';

/** Helper to create authenticated params for a given role and provider */
function makeParams(role: string, provider: string | undefined = 'rest'): AuthenticatedParams {
  return {
    user: {
      user_id: 'user-test-0001',
      email: 'test@example.com',
      role,
    },
    authenticated: true,
    provider,
  } as AuthenticatedParams;
}

describe('ensureMinimumRole', () => {
  describe('role hierarchy', () => {
    it('superadmin passes admin check', () => {
      expect(() => ensureMinimumRole(makeParams(ROLES.SUPERADMIN), ROLES.ADMIN)).not.toThrow();
    });

    it('admin passes member check', () => {
      expect(() => ensureMinimumRole(makeParams(ROLES.ADMIN), ROLES.MEMBER)).not.toThrow();
    });

    it('member fails admin check', () => {
      expect(() => ensureMinimumRole(makeParams(ROLES.MEMBER), ROLES.ADMIN)).toThrow(Forbidden);
    });

    it('viewer fails member check', () => {
      expect(() => ensureMinimumRole(makeParams(ROLES.VIEWER), ROLES.MEMBER)).toThrow(Forbidden);
    });

    it('deprecated owner role treated as superadmin rank', () => {
      expect(() => ensureMinimumRole(makeParams('owner'), ROLES.ADMIN)).not.toThrow();
      expect(() => ensureMinimumRole(makeParams('owner'), ROLES.SUPERADMIN)).not.toThrow();
    });
  });

  describe('provider gating', () => {
    it('skips auth check when params is undefined (internal call)', () => {
      expect(() => ensureMinimumRole(undefined, ROLES.ADMIN)).not.toThrow();
    });

    it('skips auth check when provider is absent (internal call)', () => {
      // Params object without provider property — simulates daemon-internal calls
      const params = {
        user: { user_id: 'u1', email: 'a@b.c', role: ROLES.VIEWER },
        authenticated: true,
      } as AuthenticatedParams;
      expect(() => ensureMinimumRole(params, ROLES.ADMIN)).not.toThrow();
    });

    it('enforces auth check when provider is set', () => {
      expect(() => ensureMinimumRole(makeParams(ROLES.VIEWER, 'rest'), ROLES.ADMIN)).toThrow(
        Forbidden
      );
    });

    it('enforces auth check when provider is "mcp"', () => {
      expect(() => ensureMinimumRole(makeParams(ROLES.VIEWER, 'mcp'), ROLES.ADMIN)).toThrow(
        Forbidden
      );
    });

    it('enforces auth check when provider is "socketio"', () => {
      expect(() => ensureMinimumRole(makeParams(ROLES.VIEWER, 'socketio'), ROLES.ADMIN)).toThrow(
        Forbidden
      );
    });
  });

  describe('MCP auth parity with REST', () => {
    const roles = [ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MEMBER, ROLES.VIEWER] as const;
    const minimumRoles = [ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MEMBER, ROLES.VIEWER] as const;

    for (const role of roles) {
      for (const minRole of minimumRoles) {
        it(`${role} vs ${minRole}: MCP and REST produce same result`, () => {
          const restParams = makeParams(role, 'rest');
          const mcpParams = makeParams(role, 'mcp');

          let restResult: 'pass' | string;
          let mcpResult: 'pass' | string;

          try {
            ensureMinimumRole(restParams, minRole);
            restResult = 'pass';
          } catch (e) {
            restResult = (e as Error).constructor.name;
          }

          try {
            ensureMinimumRole(mcpParams, minRole);
            mcpResult = 'pass';
          } catch (e) {
            mcpResult = (e as Error).constructor.name;
          }

          expect(mcpResult).toBe(restResult);
        });
      }
    }
  });

  describe('edge cases', () => {
    it('throws NotAuthenticated when params is undefined', () => {
      // With provider set but no user
      const params = { provider: 'rest' } as AuthenticatedParams;
      expect(() => ensureMinimumRole(params, ROLES.MEMBER)).toThrow(NotAuthenticated);
    });

    it('skips check for service accounts', () => {
      const params = {
        user: {
          user_id: 'svc-001',
          email: 'svc@internal',
          role: ROLES.VIEWER,
          _isServiceAccount: true,
        },
        authenticated: true,
        provider: 'rest',
      } as AuthenticatedParams;
      expect(() => ensureMinimumRole(params, ROLES.ADMIN)).not.toThrow();
    });
  });
});

describe('ensureCanTriggerManagedEnv', () => {
  it('defaults to MEMBER when minimumRole is undefined', () => {
    expect(() =>
      ensureCanTriggerManagedEnv(undefined, makeParams(ROLES.MEMBER), 'start env')
    ).not.toThrow();
    expect(() =>
      ensureCanTriggerManagedEnv(undefined, makeParams(ROLES.VIEWER), 'start env')
    ).toThrow(Forbidden);
  });

  it("'none' kill-switch throws Forbidden for any external caller, even superadmin", () => {
    expect(() =>
      ensureCanTriggerManagedEnv('none', makeParams(ROLES.SUPERADMIN), 'start env')
    ).toThrow(Forbidden);
    expect(() => ensureCanTriggerManagedEnv('none', makeParams(ROLES.ADMIN), 'start env')).toThrow(
      Forbidden
    );
  });

  it("'none' kill-switch allows internal calls (no provider)", () => {
    // Daemon-initiated health loops, scheduler, etc. must not be blocked.
    const internal = {
      user: { user_id: 'u1', email: 'a@b.c', role: ROLES.ADMIN },
      authenticated: true,
    } as AuthenticatedParams;
    expect(() => ensureCanTriggerManagedEnv('none', internal, 'start env')).not.toThrow();
    expect(() => ensureCanTriggerManagedEnv('none', undefined, 'start env')).not.toThrow();
  });

  it("'admin' blocks members but allows admins/superadmins", () => {
    expect(() =>
      ensureCanTriggerManagedEnv(ROLES.ADMIN, makeParams(ROLES.MEMBER), 'start env')
    ).toThrow(Forbidden);
    expect(() =>
      ensureCanTriggerManagedEnv(ROLES.ADMIN, makeParams(ROLES.ADMIN), 'start env')
    ).not.toThrow();
    expect(() =>
      ensureCanTriggerManagedEnv(ROLES.ADMIN, makeParams(ROLES.SUPERADMIN), 'start env')
    ).not.toThrow();
  });

  it('enforces MCP provider parity with REST', () => {
    // MCP tools must hit the same gate as REST routes.
    expect(() =>
      ensureCanTriggerManagedEnv(ROLES.ADMIN, makeParams(ROLES.MEMBER, 'mcp'), 'start env')
    ).toThrow(Forbidden);
  });

  it('service accounts bypass the gate (same as ensureMinimumRole)', () => {
    const svc = {
      user: {
        user_id: 'svc',
        email: 'svc@internal',
        role: ROLES.VIEWER,
        _isServiceAccount: true,
      },
      authenticated: true,
      provider: 'rest',
    } as AuthenticatedParams;
    expect(() => ensureCanTriggerManagedEnv(ROLES.ADMIN, svc, 'start env')).not.toThrow();
  });
});

describe('requireMinimumRole (hook factory)', () => {
  it('returns a function that checks role on hook context', () => {
    const hook = requireMinimumRole(ROLES.ADMIN, 'test action');
    expect(typeof hook).toBe('function');

    // Simulate hook context with admin user and provider set
    const context = {
      params: makeParams(ROLES.ADMIN, 'rest'),
    } as import('@agor/core/types').HookContext;

    expect(() => hook(context)).not.toThrow();
  });

  it('throws when role is insufficient', () => {
    const hook = requireMinimumRole(ROLES.ADMIN, 'test action');
    const context = {
      params: makeParams(ROLES.MEMBER, 'mcp'),
    } as import('@agor/core/types').HookContext;

    expect(() => hook(context)).toThrow(Forbidden);
  });
});
