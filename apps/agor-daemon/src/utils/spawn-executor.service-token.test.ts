import { runWithTenantContext } from '@agor/core/db';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  configureExecutor,
  generateDaemonServiceToken,
  generateTerminalExecutorToken,
  serviceTokenScopeForCurrentTenant,
} from './spawn-executor';

const LOCAL_RESPONSE_OPTIONS = { localResponseOriginUrl: 'http://localhost:3030' } as const;

describe('daemon tenant service token binding', () => {
  beforeEach(() => configureExecutor(null, LOCAL_RESPONSE_OPTIONS));

  it('copies ambient tenant context into service token claims', () => {
    const token = runWithTenantContext('tenant-a', () =>
      generateDaemonServiceToken({
        settings: { authentication: { secret: 'test-secret' } },
      })
    );
    const decoded = jwt.decode(token) as { tenant_id?: string; type?: string };

    expect(decoded.type).toBe('service');
    expect(decoded.tenant_id).toBe('tenant-a');
  });

  it('omits the tenant claim outside tenant context when it is not required', () => {
    expect(serviceTokenScopeForCurrentTenant()).toEqual({});
  });

  it('preserves ambient tenant identity across asynchronous orchestration', async () => {
    const token = await runWithTenantContext('tenant-async', async () => {
      await Promise.resolve();
      return generateDaemonServiceToken({
        settings: { authentication: { secret: 'test-secret' } },
      });
    });
    const decoded = jwt.decode(token) as { tenant_id?: string };

    expect(decoded.tenant_id).toBe('tenant-async');
  });

  it('stamps role: service for a plain service token', () => {
    const decoded = jwt.decode(
      generateDaemonServiceToken({
        settings: { authentication: { secret: 'test-secret' } },
      })
    ) as { role?: string };
    expect(decoded.role).toBe('service');
  });

  it('stamps role: terminal-executor for a terminal-scoped token (no full service role)', () => {
    // Both resolvers override role before use, but a token that leaks its raw
    // role must not read as a full service account to any future consumer.
    const decoded = jwt.decode(
      generateTerminalExecutorToken(
        { settings: { authentication: { secret: 'test-secret' } } },
        {
          terminal_user_id: 'u1',
          terminal_id: 'terminal-1',
          terminal_branch_id: 'branch-1',
          terminal_owner_boot_id: 'boot-1',
        },
        '30d'
      )
    ) as { role?: string; terminal_user_id?: string };
    expect(decoded.role).toBe('terminal-executor');
    expect(decoded.role).not.toBe('service');
    expect(decoded.terminal_user_id).toBe('u1');
  });

  it('keeps ambient tenant identity authoritative for terminal capabilities', () => {
    const token = runWithTenantContext('tenant-b', () =>
      generateTerminalExecutorToken(
        { settings: { authentication: { secret: 'test-secret' } } },
        {
          terminal_user_id: 'u1',
          terminal_id: 'terminal-1',
          terminal_branch_id: 'branch-1',
          terminal_owner_boot_id: 'boot-1',
        },
        '5m'
      )
    );
    const decoded = jwt.decode(token) as { tenant_id?: string; type?: string };

    expect(decoded.type).toBe('service');
    expect(decoded.tenant_id).toBe('tenant-b');
  });

  it('fails closed without ambient tenant context when required', () => {
    configureExecutor(null, { ...LOCAL_RESPONSE_OPTIONS, requireTenantContext: true });

    expect(() => serviceTokenScopeForCurrentTenant()).toThrow(
      'Missing active tenant context for executor launch'
    );
    expect(() =>
      generateDaemonServiceToken({
        settings: { authentication: { secret: 'test-secret' } },
      })
    ).toThrow('Missing active tenant context for executor launch');
  });
});
