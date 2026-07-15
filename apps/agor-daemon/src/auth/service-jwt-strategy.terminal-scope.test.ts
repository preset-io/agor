/**
 * ServiceJWTStrategy: a token carrying `terminal_user_id` must resolve to a
 * RESTRICTED terminal-executor identity, NOT a full service account. This is
 * the security boundary that keeps the long-lived terminal token from being a
 * daemon-wide RBAC bypass — every `_isServiceAccount` consumer (register-hooks,
 * board-owners, branch-owners, sessions, users, groups, …) skips its checks, so
 * the terminal token must never carry that flag or `role: 'service'`.
 */

import { JWTStrategy } from '@agor/core/feathers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceJWTStrategy } from './service-jwt-strategy';

const ALICE = '11111111-aaaa-aaaa-aaaa-111111111111';

function stubSuperAuthenticate(payload: Record<string, unknown>) {
  // super.authenticate() (base JWTStrategy) verifies the JWT and loads the
  // entity; stub it to return the verified payload + the getEntity intermediate
  // (a full service account) so we can assert the override's post-processing.
  return vi.spyOn(JWTStrategy.prototype, 'authenticate').mockResolvedValue({
    authentication: { payload },
    user: { user_id: 'executor-service', role: 'service', _isServiceAccount: true },
  } as never);
}

describe('ServiceJWTStrategy terminal-scoped identity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mints a restricted terminal-executor identity for a terminal_user_id token', async () => {
    stubSuperAuthenticate({
      sub: 'executor-service',
      type: 'service',
      purpose: 'executor-service',
      terminal_user_id: ALICE,
    });
    const strategy = new ServiceJWTStrategy();
    const result = (await strategy.authenticate({ accessToken: 'header.payload.sig' }, {})) as {
      user: Record<string, unknown>;
    };

    expect(result.user.terminal_user_id).toBe(ALICE);
    expect(result.user._isTerminalExecutor).toBe(true);
    // The critical assertions: NOT a full service account, NOT role 'service'.
    expect(result.user._isServiceAccount).toBeUndefined();
    expect(result.user.role).not.toBe('service');
  });

  it('still mints a full service account for a plain (unscoped) service token', async () => {
    stubSuperAuthenticate({
      sub: 'executor-service',
      type: 'service',
      purpose: 'executor-service',
    });
    const strategy = new ServiceJWTStrategy();
    const result = (await strategy.authenticate({ accessToken: 'header.payload.sig' }, {})) as {
      user: Record<string, unknown>;
    };

    expect(result.user._isServiceAccount).toBe(true);
    expect(result.user._isTerminalExecutor).toBeUndefined();
    expect(result.user.terminal_user_id).toBeUndefined();
  });
});
