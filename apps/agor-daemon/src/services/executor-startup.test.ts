import {
  getCurrentTenantDatabaseScope,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import type { Session } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTenantAgenticToolEnabled: vi.fn(async () => true),
}));

vi.mock('@agor/core/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/config')>()),
  isTenantAgenticToolEnabled: mocks.isTenantAgenticToolEnabled,
}));

import { prepareSessionForExecutorStart } from './executor-startup';

const session = {
  session_id: 'session-1',
  branch_id: 'branch-1',
  agentic_tool: 'codex',
  status: SessionStatus.IDLE,
} as Session;

function createSessionsService() {
  return {
    get: vi.fn(async () => {
      expect(getCurrentTenantDatabaseScope()).toMatchObject({
        kind: 'tenant',
        tenantId: 'tenant-x',
      });
      return session;
    }),
    materializeAgenticToolPreset: vi.fn(async (loaded: Session) => {
      expect(getCurrentTenantDatabaseScope()).toMatchObject({
        kind: 'tenant',
        tenantId: 'tenant-x',
      });
      return loaded;
    }),
  };
}

describe('prepareSessionForExecutorStart tenant scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTenantAgenticToolEnabled.mockImplementation(async (_tool, db) => {
      expect(db).toBe(getCurrentTenantDatabaseScope()?.db);
      return true;
    });
  });

  it('opens one short tenant unit of work from identity-only context', async () => {
    const db = { run: vi.fn() } as never;
    const sessionsService = createSessionsService();

    await expect(
      runWithTenantContext('tenant-x', () =>
        prepareSessionForExecutorStart(
          db,
          sessionsService as never,
          session.session_id,
          {} as never
        )
      )
    ).resolves.toBe(session);

    expect(sessionsService.get).toHaveBeenCalledOnce();
    expect(sessionsService.materializeAgenticToolPreset).toHaveBeenCalledOnce();
    expect(getCurrentTenantDatabaseScope()).toBeUndefined();
  });

  it('joins an existing tenant database scope', async () => {
    const db = { run: vi.fn() } as never;
    const sessionsService = createSessionsService();

    await runWithTenantContext('tenant-x', () =>
      runWithTenantDatabaseScope(db, 'tenant-x', async () => {
        const outerScope = getCurrentTenantDatabaseScope();
        await prepareSessionForExecutorStart(
          db,
          sessionsService as never,
          session.session_id,
          {} as never
        );
        expect(getCurrentTenantDatabaseScope()).toBe(outerScope);
      })
    );
  });

  it('fails fast for missing, mismatched, and system tenant identity', async () => {
    const db = { run: vi.fn() } as never;
    const sessionsService = createSessionsService();

    await expect(
      prepareSessionForExecutorStart(db, sessionsService as never, session.session_id, {} as never)
    ).rejects.toThrow('Missing active tenant context for executor startup');

    await runWithTenantDatabaseScope(db, 'tenant-b', async () => {
      await expect(
        runWithTenantContext('tenant-x', () =>
          prepareSessionForExecutorStart(
            db,
            sessionsService as never,
            session.session_id,
            {} as never
          )
        )
      ).rejects.toThrow('Cannot enter tenant scope tenant-x from active tenant scope tenant-b');
    });

    await runWithSystemDatabaseScope(db, 'executor startup test', async () => {
      await expect(
        runWithTenantContext('tenant-x', () =>
          prepareSessionForExecutorStart(
            db,
            sessionsService as never,
            session.session_id,
            {} as never
          )
        )
      ).rejects.toThrow('Cannot enter tenant scope tenant-x from active system database scope');
    });
  });
});
