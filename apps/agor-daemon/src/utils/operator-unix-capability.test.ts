import type { AuthenticatedParams } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { assertOperatorUnixHandoff } from './operator-unix-capability.js';

function params(payload: Record<string, unknown>, tenant = 'tenant-a'): AuthenticatedParams {
  return {
    provider: 'socketio',
    user: { user_id: 'executor-service', _isServiceAccount: true } as never,
    tenant: { tenant_id: tenant, source: 'auth_claim' },
    authentication: { payload },
  } as AuthenticatedParams;
}

describe('operator Unix handoff authorization', () => {
  it('accepts only the matching tenant-scoped Git lifecycle capability', () => {
    expect(() =>
      assertOperatorUnixHandoff(
        params({ command: 'git.clone', repo_id: 'repo-a', tenant_id: 'tenant-a' }),
        { command: 'git.clone', repoId: 'repo-a' }
      )
    ).not.toThrow();
  });

  it.each([
    ['ordinary user', { command: 'git.clone', repo_id: 'repo-a', tenant_id: 'tenant-a' }, false],
    ['unscoped service token', {}, true],
    ['different repo', { command: 'git.clone', repo_id: 'repo-b', tenant_id: 'tenant-a' }, true],
    ['different tenant', { command: 'git.clone', repo_id: 'repo-a', tenant_id: 'tenant-b' }, true],
  ])('rejects %s', (_name, payload, service) => {
    const value = params(payload);
    (value.user as { _isServiceAccount?: boolean })._isServiceAccount = service;
    expect(() =>
      assertOperatorUnixHandoff(value, { command: 'git.clone', repoId: 'repo-a' })
    ).toThrow(/tenant capability/);
  });
});
