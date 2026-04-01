/**
 * Authorization Utilities Tests
 *
 * Tests for role hierarchy, minimum role enforcement, and superadmin/owner backwards compat.
 * Also verifies that `provider` presence controls whether auth hooks run.
 */

import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { ensureMinimumRole, requireMinimumRole } from './authorization';

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
      expect(() => ensureMinimumRole(makeParams('superadmin'), 'admin')).not.toThrow();
    });

    it('admin passes member check', () => {
      expect(() => ensureMinimumRole(makeParams('admin'), 'member')).not.toThrow();
    });

    it('member fails admin check', () => {
      expect(() => ensureMinimumRole(makeParams('member'), 'admin')).toThrow(Forbidden);
    });

    it('viewer fails member check', () => {
      expect(() => ensureMinimumRole(makeParams('viewer'), 'member')).toThrow(Forbidden);
    });

    it('deprecated owner role treated as superadmin rank', () => {
      expect(() => ensureMinimumRole(makeParams('owner'), 'admin')).not.toThrow();
      expect(() => ensureMinimumRole(makeParams('owner'), 'superadmin')).not.toThrow();
    });
  });

  describe('provider gating', () => {
    it('skips auth check when params is undefined (internal call)', () => {
      expect(() => ensureMinimumRole(undefined, 'admin')).not.toThrow();
    });

    it('skips auth check when provider is absent (internal call)', () => {
      // Params object without provider property — simulates daemon-internal calls
      const params = {
        user: { user_id: 'u1', email: 'a@b.c', role: 'viewer' },
        authenticated: true,
      } as AuthenticatedParams;
      expect(() => ensureMinimumRole(params, 'admin')).not.toThrow();
    });

    it('enforces auth check when provider is set', () => {
      expect(() => ensureMinimumRole(makeParams('viewer', 'rest'), 'admin')).toThrow(Forbidden);
    });

    it('enforces auth check when provider is "mcp"', () => {
      expect(() => ensureMinimumRole(makeParams('viewer', 'mcp'), 'admin')).toThrow(Forbidden);
    });

    it('enforces auth check when provider is "socketio"', () => {
      expect(() => ensureMinimumRole(makeParams('viewer', 'socketio'), 'admin')).toThrow(Forbidden);
    });
  });

  describe('MCP auth parity with REST', () => {
    const roles = ['superadmin', 'admin', 'member', 'viewer'] as const;
    const minimumRoles = ['superadmin', 'admin', 'member', 'viewer'] as const;

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
      expect(() => ensureMinimumRole(params, 'member')).toThrow(NotAuthenticated);
    });

    it('skips check for service accounts', () => {
      const params = {
        user: {
          user_id: 'svc-001',
          email: 'svc@internal',
          role: 'viewer',
          _isServiceAccount: true,
        },
        authenticated: true,
        provider: 'rest',
      } as AuthenticatedParams;
      expect(() => ensureMinimumRole(params, 'admin')).not.toThrow();
    });
  });
});

describe('requireMinimumRole (hook factory)', () => {
  it('returns a function that checks role on hook context', () => {
    const hook = requireMinimumRole('admin', 'test action');
    expect(typeof hook).toBe('function');

    // Simulate hook context with admin user and provider set
    const context = {
      params: makeParams('admin', 'rest'),
    } as import('@agor/core/types').HookContext;

    expect(() => hook(context)).not.toThrow();
  });

  it('throws when role is insufficient', () => {
    const hook = requireMinimumRole('admin', 'test action');
    const context = {
      params: makeParams('member', 'mcp'),
    } as import('@agor/core/types').HookContext;

    expect(() => hook(context)).toThrow(Forbidden);
  });
});
