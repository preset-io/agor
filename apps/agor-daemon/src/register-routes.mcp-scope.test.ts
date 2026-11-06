import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TenantRestrictionState } from '@agor/core/db';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { Session, Task, TenantRestrictionRecord } from '@agor/core/types';
import { TENANT_RESTRICTED_ERROR_CODE } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  readTenantCredentialEpoch,
  tenantCredentialEpochClaims,
} from './auth/tenant-credential-epoch';
import {
  assertMcpProjectionTenantCredential,
  authorizeTaskExecutorSessionMcpRead,
  type RouteParams,
} from './register-routes';

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@agor/core/db', async (original) => ({
  ...(await original<typeof import('@agor/core/db')>()),
  readTenantRestrictionState: read,
  isPostgresDatabaseHandle: () => true,
}));

const session = {
  session_id: 'session-a',
  created_by: 'alice',
} as Session;

function executorParams(overrides: Record<string, unknown> = {}): RouteParams {
  return {
    provider: 'rest',
    authenticated: true,
    user: { user_id: 'bob', role: 'member' },
    authentication: {
      strategy: 'jwt',
      payload: {
        type: 'executor-session',
        purpose: 'executor-task',
        session_id: 'session-a',
        task_id: 'task-b',
        sub: 'bob',
        ...overrides,
      },
    },
  } as RouteParams;
}

const task = {
  task_id: 'task-b',
  session_id: 'session-a',
  created_by: 'bob',
} as Task;

describe('Session MCP executor read scope', () => {
  it('admits the actual Task actor on a shared Session', async () => {
    const findTask = vi.fn(async () => task);

    await expect(
      authorizeTaskExecutorSessionMcpRead(executorParams(), session, findTask)
    ).resolves.toBe(true);
    expect(findTask).toHaveBeenCalledWith('task-b');
  });

  it('rejects another Session, Task, or prompt actor', async () => {
    await expect(
      authorizeTaskExecutorSessionMcpRead(
        executorParams({ session_id: 'session-other' }),
        session,
        async () => task
      )
    ).rejects.toThrow('not scoped to this session');
    await expect(
      authorizeTaskExecutorSessionMcpRead(executorParams(), session, async () => ({
        ...task,
        task_id: 'task-other',
      }))
    ).rejects.toThrow('no longer current');
    await expect(
      authorizeTaskExecutorSessionMcpRead(executorParams(), session, async () => ({
        ...task,
        created_by: 'alice',
      }))
    ).rejects.toThrow('no longer current');
  });

  it('does not grant ordinary browser callers an executor exemption', async () => {
    await expect(
      authorizeTaskExecutorSessionMcpRead(
        {
          provider: 'rest',
          authenticated: true,
          user: { user_id: 'bob', role: 'member' },
          authentication: { strategy: 'jwt', payload: { type: 'access', sub: 'bob' } },
        } as RouteParams,
        session,
        vi.fn()
      )
    ).resolves.toBe(false);
  });

  it('keeps every MCP relationship mutation behind the owner/admin and projection boundary', () => {
    const source = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');
    const routeStart = source.indexOf("'/sessions/:id/mcp-servers'");
    const routeEnd = source.indexOf('// MCP member policy', routeStart);
    const route = source.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThan(0);
    expect(route.match(/authorizeAndLoadSessionForMcpConfig\(id, params\);/g)).toHaveLength(5);
    expect(
      route.match(
        /authorizeAndLoadSessionForMcpConfig\(id, params, \{\s*allowExecutorProjection: true,?\s*\}\)/g
      )
    ).toHaveLength(1);
  });
});

describe('MCP projection tenant credential check', () => {
  const record = (phase: TenantRestrictionRecord['phase']): TenantRestrictionRecord => ({
    version: 1,
    controllerId: 'c',
    placementId: 'p',
    operationId: 'op',
    revision: 3,
    phase,
  });
  const restriction = (phase: TenantRestrictionRecord['phase']): TenantRestrictionState => ({
    records: [record(phase)],
    closed: phase !== 'active',
  });
  const db = {} as never;

  it('admits an API key on an open tenant with restriction history without a generation claim', async () => {
    read.mockResolvedValue(restriction('active'));
    await expect(
      assertMcpProjectionTenantCredential(db, 't', { strategy: 'api-key' })
    ).resolves.toBeUndefined();
    // A signed runtime JWT still has to carry the current generation.
    await expect(
      assertMcpProjectionTenantCredential(db, 't', { strategy: 'jwt', payload: {} })
    ).rejects.toBeInstanceOf(NotAuthenticated);
    const epoch = await readTenantCredentialEpoch(db, 't');
    await expect(
      assertMcpProjectionTenantCredential(db, 't', {
        strategy: 'jwt',
        payload: tenantCredentialEpochClaims(epoch),
      })
    ).resolves.toBe(epoch);
  });

  it('still refuses an API key on a closed tenant with the stable code', async () => {
    read.mockResolvedValue(restriction('restricted'));
    const refusal = assertMcpProjectionTenantCredential(db, 't', { strategy: 'api-key' });
    await expect(refusal).rejects.toBeInstanceOf(Forbidden);
    await expect(refusal).rejects.toMatchObject({ data: { code: TENANT_RESTRICTED_ERROR_CODE } });
  });
});
