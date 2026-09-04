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
  sdk_home_scope: 'execution_home',
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

  it('rejects startup for a historical removed-runtime session before policy lookup', async () => {
    const db = { run: vi.fn() } as never;
    const historicalSession = {
      ...session,
      agentic_tool: 'claude-code-cli',
    } as Session;
    const sessionsService = {
      get: vi.fn(async () => historicalSession),
      materializeAgenticToolPreset: vi.fn(),
    };

    await expect(
      runWithTenantContext('tenant-x', () =>
        prepareSessionForExecutorStart(
          db,
          sessionsService as never,
          historicalSession.session_id,
          {} as never
        )
      )
    ).rejects.toThrow(/removed experimental Claude Code CLI integration/i);

    expect(mocks.isTenantAgenticToolEnabled).not.toHaveBeenCalled();
    expect(sessionsService.materializeAgenticToolPreset).not.toHaveBeenCalled();
  });

  it('rejects a tenant-disabled built-in workload before materialization or spawn', async () => {
    const db = { run: vi.fn() } as never;
    const workloadSession = { ...session, agentic_tool: 'workload' } as Session;
    const sessionsService = {
      get: vi.fn(async () => workloadSession),
      materializeAgenticToolPreset: vi.fn(),
    };
    mocks.isTenantAgenticToolEnabled.mockResolvedValueOnce(false);

    await expect(
      runWithTenantContext('tenant-x', () =>
        prepareSessionForExecutorStart(
          db,
          sessionsService as never,
          workloadSession.session_id,
          {} as never,
          { managed: true, installed: new Set() }
        )
      )
    ).rejects.toThrow('workload is disabled for this workspace');

    expect(sessionsService.materializeAgenticToolPreset).not.toHaveBeenCalled();
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

  /**
   * `/sessions/:id/prompt` admits its Task through the repository and treats
   * the `messages.create` write — where the transport guard lives — as
   * best-effort, so the launch itself has to refuse a session whose creator no
   * longer owns the stamped `unix_username`.
   */
  describe('stale unix identity', () => {
    const stampedSession = { ...session, created_by: 'user-1', unix_username: 'alice' } as Session;

    const prepareWithCreator = (creator: { unix_username: string | null } | null) => {
      const loadCreator = vi.fn(async () => creator);
      // The loader is handed the tenant-scoped handle this startup opened —
      // asserted on the argument, not on the ambient scope, which was already
      // active before that handle was threaded through.
      const guard = {
        loadCreator: vi.fn((tenantDb: unknown) => {
          expect(tenantDb).toBe(getCurrentTenantDatabaseScope()?.db);
          return loadCreator;
        }),
      };
      const sessionsService = {
        get: vi.fn(async () => stampedSession),
        materializeAgenticToolPreset: vi.fn(async (loaded: Session) => loaded),
      };
      const run = runWithTenantContext('tenant-x', () =>
        prepareSessionForExecutorStart(
          { run: vi.fn() } as never,
          sessionsService as never,
          stampedSession.session_id,
          {} as never,
          undefined,
          guard
        )
      );
      return { run, sessionsService, loadCreator, guard };
    };

    it('refuses the launch when the creator has been renamed', async () => {
      const { run, sessionsService } = prepareWithCreator({ unix_username: 'alice-renamed' });

      await expect(run).rejects.toThrow(/Session security context has changed/);
      expect(sessionsService.materializeAgenticToolPreset).not.toHaveBeenCalled();
    });

    it('refuses the launch when the creator no longer exists', async () => {
      const { run } = prepareWithCreator(null);

      await expect(run).rejects.toThrow(/Session creator not found/);
    });

    it('launches while the creator still owns the stamped identity', async () => {
      const { run, loadCreator, guard } = prepareWithCreator({ unix_username: 'alice' });

      await expect(run).resolves.toBe(stampedSession);
      expect(guard.loadCreator).toHaveBeenCalledOnce();
      expect(loadCreator).toHaveBeenCalledWith(stampedSession.created_by);
    });

    it("does not validate the creator's old home for a branch-scoped session", async () => {
      const branchSession = { ...stampedSession, sdk_home_scope: 'branch' as const };
      const loadCreator = vi.fn(async () => ({ unix_username: 'alice-renamed' }));
      const guard = { loadCreator: vi.fn(() => loadCreator) };
      const sessionsService = {
        get: vi.fn(async () => branchSession),
        materializeAgenticToolPreset: vi.fn(async (loaded: Session) => loaded),
      };

      await expect(
        runWithTenantContext('tenant-x', () =>
          prepareSessionForExecutorStart(
            { run: vi.fn() } as never,
            sessionsService as never,
            branchSession.session_id,
            {} as never,
            undefined,
            guard
          )
        )
      ).resolves.toBe(branchSession);
      expect(guard.loadCreator).not.toHaveBeenCalled();
      expect(loadCreator).not.toHaveBeenCalled();
    });

    // `register-services.ts` builds the guard only when the resolved execution
    // mode requires a per-user `unix_username`; every other mode launches
    // through this same call with no guard and therefore no creator read.
    it('launches with no guard at all when the caller supplies none', async () => {
      const sessionsService = createSessionsService();

      await expect(
        runWithTenantContext('tenant-x', () =>
          prepareSessionForExecutorStart(
            { run: vi.fn() } as never,
            sessionsService as never,
            session.session_id,
            {} as never
          )
        )
      ).resolves.toBe(session);
    });
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
