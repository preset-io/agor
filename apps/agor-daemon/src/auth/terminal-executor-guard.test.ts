/**
 * Proves the terminal-executor identity is REJECTED from REST/Feathers — not
 * merely under-privileged. These exercise the real production authz predicates
 * (`requireMinimumRole` / `hasMinimumRole`), not token shape, which is exactly
 * the gap a shape-only test missed: `role: 'terminal-executor'` falls through
 * the RBAC rank table to viewer rank and would otherwise pass viewer gating.
 */

import { Forbidden } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { requireMinimumRole } from '../utils/authorization';
import {
  isTerminalExecutorIdentity,
  rejectTerminalExecutorIdentity,
} from './terminal-executor-guard';

const terminalUser = {
  user_id: 'executor-service',
  email: 'executor@agor.internal',
  role: 'terminal-executor',
  _isTerminalExecutor: true,
  terminal_user_id: '11111111-aaaa-aaaa-aaaa-111111111111',
};

function ctx(user: unknown): HookContext {
  return { params: { provider: 'rest', user } } as unknown as HookContext;
}

describe('terminal-executor identity is rejected from REST/Feathers', () => {
  it('THE GAP: the RBAC rank system alone does not reject the terminal role', () => {
    // Real production predicate: 'terminal-executor' isn't a rank key, so it
    // falls through to 0 (== viewer). This is why an explicit reject is needed.
    expect(hasMinimumRole('terminal-executor', ROLES.VIEWER)).toBe(true);
  });

  it('THE GAP: a real viewer-gated hook lets the terminal identity through', () => {
    const viewerGate = requireMinimumRole(ROLES.VIEWER, 'read data');
    // Without the guard, this does NOT throw — the terminal token would reach
    // the service handler with viewer-level access.
    expect(() => viewerGate(ctx(terminalUser))).not.toThrow();
    expect(viewerGate(ctx(terminalUser))).toBeDefined();
  });

  it('THE FIX: the guard rejects the terminal identity outright', async () => {
    await expect(rejectTerminalExecutorIdentity(ctx(terminalUser))).rejects.toBeInstanceOf(
      Forbidden
    );
    await expect(rejectTerminalExecutorIdentity(ctx(terminalUser))).rejects.toThrow(
      /not valid for API access/
    );
  });

  it('lets normal users and full service accounts through the guard', async () => {
    await expect(
      rejectTerminalExecutorIdentity(ctx({ user_id: 'u', role: 'member' }))
    ).resolves.toBeDefined();
    await expect(
      rejectTerminalExecutorIdentity(
        ctx({ user_id: 'executor-service', role: 'service', _isServiceAccount: true })
      )
    ).resolves.toBeDefined();
    // Internal calls (no provider / no user) are untouched.
    await expect(
      rejectTerminalExecutorIdentity({ params: {} } as unknown as HookContext)
    ).resolves.toBeDefined();
  });

  it('isTerminalExecutorIdentity discriminates the identity', () => {
    expect(isTerminalExecutorIdentity({ _isTerminalExecutor: true })).toBe(true);
    expect(isTerminalExecutorIdentity({ _isServiceAccount: true })).toBe(false);
    expect(isTerminalExecutorIdentity({ role: 'member' })).toBe(false);
    expect(isTerminalExecutorIdentity(undefined)).toBe(false);
  });
});
