/**
 * Proves the terminal-executor identity is REJECTED from REST/Feathers — not
 * merely under-privileged. These exercise the real production authz predicates
 * (`requireMinimumRole` / `hasMinimumRole`) as well as the explicit guard. The
 * rank helper and the transport guard are intentionally defense in depth.
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
  it('fails closed when the RBAC rank system sees the terminal role', () => {
    expect(hasMinimumRole('terminal-executor', ROLES.VIEWER)).toBe(false);
  });

  it('does not let the terminal identity through a viewer-gated hook', () => {
    const viewerGate = requireMinimumRole(ROLES.VIEWER, 'read data');
    expect(() => viewerGate(ctx(terminalUser))).toThrow(Forbidden);
    expect(() => viewerGate(ctx(terminalUser))).toThrow(/viewer access/);
  });

  it('the transport guard still rejects the terminal identity outright', async () => {
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
